"""
LSL → WebSocket Bridge
======================
Discovers all available LSL streams, lets clients select one, and
broadcasts samples to all connected WebSocket clients.

Message types (JSON):
  Server → Client:
    { "type": "streams",      "streams": [{ name, channel_count, sample_rate, type, source_id }] }
    { "type": "sample",       "value": float, "timestamp": float }
    { "type": "connected",    "stream": { name, channel_count, sample_rate, type, source_id } }
    { "type": "disconnected", "reason": str }
    { "type": "searching",    "stream_name": str }

  Client → Server:
    { "type": "select_stream", "name": str }

Usage:
  python main.py

Dependencies:
  pip install pylsl websockets
"""

import asyncio
import json
import logging
import websockets
from pylsl import StreamInlet, resolve_byprop, resolve_streams as lsl_resolve_streams

# #########
# CONSTANTS
# #########

WS_HOST            = "localhost"
WS_PORT            = 8765
DISCOVERY_WAIT     = 1.0   # seconds per resolve_streams call
DISCOVERY_INTERVAL = 2.0   # extra sleep between discovery rounds
PULL_TIMEOUT       = 2.0   # seconds to wait for a single sample

# #######
# LOGGING
# #######

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("lsl_bridge")


# ############
# BRIDGE STATE
# ############

class BridgeState:
    """Shared mutable state between all bridge coroutines."""

    def __init__(self):
        self.clients: set                = set()
        self.stream_info: dict | None    = None
        self.connected: bool             = False
        self.available_streams: list     = []
        self.selected_stream_name: str | None = None
        # set after the event loop starts (in main)
        self.stream_change_event: asyncio.Event


# #######
# HELPERS
# #######

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


# #################
# STREAM DISCOVERER
# #################

async def stream_discoverer(state: BridgeState) -> None:
    """
    Periodically resolves all available LSL streams and broadcasts the
    list to clients whenever it changes.
    """
    loop = asyncio.get_running_loop()
    prev_names: frozenset = frozenset()

    while True:
        try:
            results = await loop.run_in_executor(
                None,
                lambda: lsl_resolve_streams(wait_time=DISCOVERY_WAIT),
            )
            streams = [_info_to_dict(r) for r in results]
            names   = frozenset(s["name"] for s in streams)

            if names != prev_names:
                state.available_streams = streams
                prev_names = names
                log.info(f"Available streams: {names or '(none)'}")
                await _broadcast(state, {"type": "streams", "streams": streams})

        except Exception as exc:
            log.warning(f"Discovery error: {exc}")

        await asyncio.sleep(DISCOVERY_INTERVAL)


# ##########
# LSL READER
# ##########

async def read_one_stream(
    name: str,
    state: BridgeState,
    stop: asyncio.Event,
) -> None:
    """
    Connect to the named LSL stream and stream samples until `stop` is set
    or the stream is lost.  On stream loss, signals lsl_reader to reconnect.
    """
    loop = asyncio.get_running_loop()
    inlet = None

    try:
        log.info(f"Searching for LSL stream '{name}' …")
        await _broadcast(state, {"type": "searching", "stream_name": name})

        # ── resolve ──────────────────────────────────────────────────────
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
                log.warning(f"Resolve failed: {exc} — retrying …")
                await asyncio.sleep(2.0)

        if stop.is_set() or inlet is None:
            return

        # ── connected ────────────────────────────────────────────────────
        info = _info_to_dict(inlet.info())
        state.stream_info = info
        state.connected   = True
        log.info(f"Connected: {info}")
        await _broadcast(state, {"type": "connected", "stream": info})

        sample_count = 0
        last_log     = loop.time()

        # ── read loop ────────────────────────────────────────────────────
        while not stop.is_set():
            sample, timestamp = await loop.run_in_executor(
                None,
                lambda: inlet.pull_sample(timeout=PULL_TIMEOUT),  # type: ignore
            )
            if stop.is_set():
                break
            if sample is None:
                continue

            value = sample[0]
            sample_count += 1

            now = loop.time()
            if now - last_log >= 1.0:
                log.info(f"Sample rate: {sample_count} Hz")
                sample_count = 0
                last_log     = now

            await _broadcast(state, {
                "type":      "sample",
                "value":     value,
                "timestamp": timestamp,
            })

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        log.warning(f"Unexpected error in read loop: {exc}")
    finally:
        state.connected   = False
        state.stream_info = None
        if inlet is not None:
            try:
                inlet.close_stream()
            except Exception:
                pass
        if not stop.is_set():
            # Stream lost — notify clients and schedule reconnect
            await _broadcast(state, {
                "type":   "disconnected",
                "reason": "LSL stream lost — reconnecting …",
            })
            await asyncio.sleep(1.0)
            state.stream_change_event.set()


async def lsl_reader(state: BridgeState) -> None:
    """
    Manages the active stream reader task.  Reacts to stream_change_event
    to switch streams or reconnect after a loss.
    """
    current_task: asyncio.Task | None = None
    current_stop: asyncio.Event | None = None

    while True:
        await state.stream_change_event.wait()
        state.stream_change_event.clear()

        # ── stop current reader ──────────────────────────────────────────
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
            state.connected   = False
            state.stream_info = None
            await _broadcast(state, {"type": "disconnected", "reason": "No stream selected."})
            current_task = None
            current_stop = None
            continue

        stop = asyncio.Event()
        current_stop = stop
        current_task = asyncio.create_task(read_one_stream(name, state, stop))


# ##################
# WEBSOCKETS HANDLER
# ##################

async def ws_handler(
    websocket: websockets.WebSocketServerProtocol,  # type: ignore
    state: BridgeState,
) -> None:
    """
    Registers a new client, sends current state, and listens for
    select_stream requests.
    """
    state.clients.add(websocket)
    remote = websocket.remote_address
    log.info(f"Client connected: {remote}  (total: {len(state.clients)})")

    # ── greet new client with current state ──────────────────────────────
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

    # ── receive messages from client ─────────────────────────────────────
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "select_stream":
                    name = msg.get("name")
                    log.info(f"Client requested stream: {name!r}")
                    state.selected_stream_name = name
                    state.stream_change_event.set()
            except json.JSONDecodeError:
                pass
    finally:
        state.clients.discard(websocket)
        log.info(f"Client disconnected: {remote}  (total: {len(state.clients)})")


# ####
# MAIN
# ####

async def main() -> None:
    state = BridgeState()
    state.stream_change_event = asyncio.Event()

    asyncio.create_task(stream_discoverer(state))
    asyncio.create_task(lsl_reader(state))

    async def handler(websocket):
        await ws_handler(websocket, state)

    log.info(f"WebSocket server listening on ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(handler, WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Bridge stopped.")
