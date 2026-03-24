"""
LSL → WebSocket Bridge
======================
Discovers an LSL stream by name, pulls samples, and broadcasts them
to all connected WebSocket clients on ws://localhost:<port>.

Message types (JSON):
  { "type": "sample",  "value": float, "timestamp": float,
    "breath_rate": float | null }
  { "type": "connected",    "stream": { name, channel_count, sample_rate } }
  { "type": "disconnected", "reason": str }
  { "type": "error",        "message": str }

Usage:
  python bridge.py

Dependencies:
  pip install pylsl websockets scipy
"""

# ── configuration ─────────────────────────────────────────────────────────────

STREAM_NAME = "MyRespirationBelt"   # LSL stream name to subscribe to
WS_HOST     = "localhost"
WS_PORT     = 8765

import asyncio
import json
import logging
import time
from collections import deque

import websockets
from pylsl import StreamInlet, resolve_byprop, LostError
from scipy.signal import find_peaks

# ── logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("lsl_bridge")

# ── breath-rate estimator ─────────────────────────────────────────────────────

class BreathRateEstimator:
    """
    Estimates breathing rate (breaths per minute) from a rolling window
    of raw respiration samples using peak detection.

    Args:
        window_seconds: How many seconds of signal to keep in the buffer.
        sample_rate:    Nominal sample rate of the LSL stream (Hz).
    """

    def __init__(self, window_seconds: float = 30.0, sample_rate: float = 100.0):
        self.window_size = int(window_seconds * sample_rate)
        self.sample_rate = sample_rate
        self._buf: deque[float] = deque(maxlen=self.window_size)
        self._last_rate: float | None = None

    def update(self, sample_rate: float) -> None:
        """Call if the stream's actual sample rate becomes known at runtime."""
        self.sample_rate = sample_rate
        self.window_size = int(30.0 * sample_rate)
        self._buf = deque(self._buf, maxlen=self.window_size)

    def push(self, value: float) -> float | None:
        """
        Add one sample. Returns the current breath rate estimate (BPM),
        or None if the buffer does not yet hold enough data.
        """
        self._buf.append(value)

        # Need at least 10 s of data before estimating
        min_samples = int(10.0 * self.sample_rate)
        if len(self._buf) < min_samples:
            return None

        signal = list(self._buf)

        # Peak distance: no two breaths closer than 1.5 s apart
        min_distance = int(1.5 * self.sample_rate)
        peaks, _ = find_peaks(signal, distance=min_distance, prominence=0.05)

        if len(peaks) < 2:
            return self._last_rate

        # Duration covered by the peaks (not the whole buffer)
        duration_seconds = (peaks[-1] - peaks[0]) / self.sample_rate
        if duration_seconds <= 0:
            return self._last_rate

        bpm = (len(peaks) - 1) / duration_seconds * 60.0
        self._last_rate = round(bpm, 2)
        return self._last_rate


# ── bridge state ──────────────────────────────────────────────────────────────

class BridgeState:
    """Shared mutable state passed between the LSL reader and WS broadcaster."""

    def __init__(self):
        self.clients: set[websockets.WebSocketServerProtocol] = set()
        self.stream_info: dict | None = None   # set once connected
        self.connected: bool = False


# ── helpers ───────────────────────────────────────────────────────────────────

def _stream_info_dict(inlet: StreamInlet) -> dict:
    info = inlet.info()
    return {
        "name": info.name(),
        "channel_count": info.channel_count(),
        "sample_rate": info.nominal_srate(),
        "type": info.type(),
        "source_id": info.source_id(),
    }


async def _broadcast(state: BridgeState, message: dict) -> None:
    """Send a JSON message to every connected WebSocket client."""
    if not state.clients:
        return
    payload = json.dumps(message)
    await asyncio.gather(
        *[ws.send(payload) for ws in state.clients],
        return_exceptions=True,
    )


# ── LSL reader loop ───────────────────────────────────────────────────────────

async def lsl_reader(stream_name: str, state: BridgeState) -> None:
    """
    Continuously resolves the named LSL stream, reads samples, and
    broadcasts them.  Automatically reconnects on disconnect.
    """
    estimator = BreathRateEstimator()
    RESOLVE_TIMEOUT = 5.0   # seconds per resolve attempt
    PULL_TIMEOUT    = 2.0   # seconds to wait for a single sample

    while True:
        # ── resolve ──────────────────────────────────────────────────────────
        log.info(f"Searching for LSL stream '{stream_name}' …")
        await _broadcast(state, {
            "type": "searching",
            "stream_name": stream_name,
        })

        inlet = None
        while inlet is None:
            try:
                # resolve_byprop is blocking — run in thread to stay async
                results = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: resolve_byprop("name", stream_name, timeout=RESOLVE_TIMEOUT),
                )
                if results:
                    inlet = StreamInlet(results[0])
            except Exception as exc:
                log.warning(f"Resolve failed: {exc} — retrying …")
                await asyncio.sleep(2.0)

        # ── connected ────────────────────────────────────────────────────────
        info = _stream_info_dict(inlet)
        state.stream_info = info
        state.connected = True
        estimator.update(info["sample_rate"] or 100.0)

        log.info(f"Connected: {info}")
        await _broadcast(state, {"type": "connected", "stream": info})

        # ── read loop ────────────────────────────────────────────────────────
        try:
            while True:
                sample, timestamp = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: inlet.pull_sample(timeout=PULL_TIMEOUT),
                )

                if sample is None:
                    # timeout — check the stream is still alive
                    continue

                value = sample[0]
                breath_rate = estimator.push(value)

                await _broadcast(state, {
                    "type": "sample",
                    "value": value,
                    "timestamp": timestamp,
                    "breath_rate": breath_rate,
                })

        except LostError:
            log.warning("LSL stream lost — attempting reconnect …")
        except Exception as exc:
            log.error(f"Unexpected error in read loop: {exc}")
        finally:
            state.connected = False
            state.stream_info = None
            try:
                inlet.close_stream()
            except Exception:
                pass
            await _broadcast(state, {
                "type": "disconnected",
                "reason": "LSL stream lost — reconnecting …",
            })
            await asyncio.sleep(1.0)


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def ws_handler(
    websocket: websockets.WebSocketServerProtocol,
    state: BridgeState,
) -> None:
    """
    Registers a new client.  Immediately sends current stream state so
    late-joining frontends know whether a device is already connected.
    """
    state.clients.add(websocket)
    remote = websocket.remote_address
    log.info(f"Client connected: {remote}  (total: {len(state.clients)})")

    # Greet new client with current connection state
    if state.connected and state.stream_info:
        await websocket.send(json.dumps({
            "type": "connected",
            "stream": state.stream_info,
        }))
    else:
        await websocket.send(json.dumps({
            "type": "disconnected",
            "reason": "No LSL stream connected yet.",
        }))

    try:
        await websocket.wait_closed()
    finally:
        state.clients.discard(websocket)
        log.info(f"Client disconnected: {remote}  (total: {len(state.clients)})")


# ── entry point ───────────────────────────────────────────────────────────────

async def main() -> None:
    state = BridgeState()

    # Start the LSL reader as a background task
    asyncio.create_task(lsl_reader(STREAM_NAME, state))

    # Wrap the handler so we can inject state without globals
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