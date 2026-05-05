import asyncio
import json
import logging

import websockets
from pylsl import StreamInlet, resolve_byprop, resolve_streams as lsl_resolve_streams

from config import DISCOVERY_WAIT, DISCOVERY_INTERVAL, PULL_TIMEOUT, SAMPLE_RATE_LOG_INTERVAL

# ── Shared state ───────────────────────────────────────────────────────────────

class BridgeState:
    """Shared mutable state threaded through all signal-bridge coroutines."""

    def __init__(self, label: str = "signal"):
        self.label = label
        self.log = logging.getLogger(f"lsl_bridge.{label}")
        self.clients: set = set()
        self.stream_info: dict | None = None
        self.connected: bool = False
        self.available_streams: list = []
        self.selected_stream_name: str | None = None
        # set after the event loop starts (in main)
        self.stream_change_event: asyncio.Event


# ── Helpers ────────────────────────────────────────────────────────────────────

def _info_to_dict(info) -> dict:
    return {
        "name":          info.name(),
        "channel_count": info.channel_count(),
        "sample_rate":   info.nominal_srate(),
        "type":          info.type(),
        "source_id":     info.source_id(),
    }


async def _broadcast(state: BridgeState, message: dict) -> None:
    if not state.clients:
        return
    payload = json.dumps(message)
    await asyncio.gather(
        *[ws.send(payload) for ws in state.clients],
        return_exceptions=True,
    )


# ── Stream discoverer ──────────────────────────────────────────────────────────

async def stream_discoverer(state: BridgeState) -> None:
    """Periodically resolves available LSL streams and broadcasts the list to clients."""
    loop = asyncio.get_running_loop()
    prev_names: frozenset = frozenset()

    while True:
        try:
            results = await loop.run_in_executor(
                None,
                lambda: lsl_resolve_streams(wait_time=DISCOVERY_WAIT),
            )
            streams = [_info_to_dict(r) for r in results]
            names = frozenset(s["name"] for s in streams)

            if names != prev_names:
                state.available_streams = streams
                prev_names = names
                state.log.info(f"Available streams: {names or '(none)'}")
                await _broadcast(state, {"type": "streams", "streams": streams})

        except Exception as exc:
            state.log.warning(f"Discovery error: {exc}")

        await asyncio.sleep(DISCOVERY_INTERVAL)


# ── LSL reader ─────────────────────────────────────────────────────────────────

async def read_one_stream(
    name: str,
    state: BridgeState,
    stop: asyncio.Event,
) -> None:
    """Connect to the named LSL stream and forward samples until stop is set or stream is lost."""
    loop = asyncio.get_running_loop()
    inlet = None

    try:
        state.log.info(f"Searching for LSL stream '{name}' …")
        await _broadcast(state, {"type": "searching", "stream_name": name})

        while inlet is None and not stop.is_set():
            try:
                results = await loop.run_in_executor(
                    None,
                    lambda: resolve_byprop("name", name, timeout=5.0),
                )
                if results:
                    inlet = StreamInlet(results[0])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                state.log.warning(f"Resolve failed: {exc} — retrying …")
                await asyncio.sleep(2.0)

        if stop.is_set() or inlet is None:
            return

        info = _info_to_dict(inlet.info())
        state.stream_info = info
        state.connected = True
        state.log.info(f"Connected: {info}")
        await _broadcast(state, {"type": "connected", "stream": info})

        sample_count = 0
        last_log = loop.time()

        while not stop.is_set():
            sample, timestamp = await loop.run_in_executor(
                None,
                lambda: inlet.pull_sample(
                    timeout=PULL_TIMEOUT),  # type: ignore
            )
            if stop.is_set():
                break
            if sample is None:
                continue

            value = sample[0]
            sample_count += 1

            now = loop.time()
            elapsed = now - last_log
            if SAMPLE_RATE_LOG_INTERVAL is not None and elapsed >= SAMPLE_RATE_LOG_INTERVAL:
                state.log.info(f"Sample rate: {sample_count / elapsed:.0f} Hz")
                sample_count = 0
                last_log = now

            await _broadcast(state, {
                "type":      "sample",
                "value":     value,
                "channels":  [float(v) for v in sample],
                "timestamp": timestamp,
            })

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        state.log.warning(f"Unexpected error in read loop: {exc}")
    finally:
        state.connected = False
        state.stream_info = None
        if inlet is not None:
            try:
                inlet.close_stream()
            except Exception:
                pass
        if not stop.is_set():
            await _broadcast(state, {
                "type":   "disconnected",
                "reason": "LSL stream lost — reconnecting …",
            })
            await asyncio.sleep(1.0)
            state.stream_change_event.set()


async def lsl_reader(state: BridgeState) -> None:
    """Manages the active stream reader task; reacts to stream_change_event."""
    current_task: asyncio.Task | None = None
    current_stop: asyncio.Event | None = None

    while True:
        await state.stream_change_event.wait()
        state.stream_change_event.clear()

        if current_stop is not None:
            current_stop.set()
        if current_task is not None and not current_task.done():
            current_task.cancel()
            try:
                await current_task
            except (asyncio.CancelledError, Exception):
                pass

        name = state.selected_stream_name
        if name is None:
            state.connected = False
            state.stream_info = None
            await _broadcast(state, {"type": "disconnected", "reason": "No stream selected."})
            current_task = None
            current_stop = None
            continue

        stop = asyncio.Event()
        current_stop = stop
        current_task = asyncio.create_task(read_one_stream(name, state, stop))


# ── WebSocket handler ──────────────────────────────────────────────────────────

async def ws_handler(websocket, state: BridgeState) -> None:
    """Registers a new client, sends current state, and listens for select_stream requests."""
    state.clients.add(websocket)
    remote = websocket.remote_address
    state.log.info(f"Client connected: {remote}  (total: {len(state.clients)})")

    await websocket.send(json.dumps({
        "type":    "streams",
        "streams": state.available_streams,
    }))

    if state.connected and state.stream_info:
        await websocket.send(json.dumps({
            "type":   "connected",
            "stream": state.stream_info,
        }))
    elif state.selected_stream_name:
        await websocket.send(json.dumps({
            "type":        "searching",
            "stream_name": state.selected_stream_name,
        }))
    else:
        await websocket.send(json.dumps({
            "type":   "disconnected",
            "reason": "No stream selected.",
        }))

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "select_stream":
                    name = msg.get("name")
                    state.log.info(f"Client requested stream: {name!r}")
                    state.selected_stream_name = name
                    state.stream_change_event.set()
            except json.JSONDecodeError:
                pass
    finally:
        state.clients.discard(websocket)
        state.log.info(
            f"Client disconnected: {remote}  (total: {len(state.clients)})")
