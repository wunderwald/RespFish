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

import asyncio
import json
import logging
import time
from collections import deque

import websockets
from pylsl import StreamInlet, resolve_byprop, LostError
from scipy.signal import find_peaks

# #########
# CONSTANTS
# #########

STREAM_NAME = "MyRespirationBelt"   # LSL stream name to subscribe to
WS_HOST     = "localhost"
WS_PORT     = 8765

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
    """Shared mutable state passed between the LSL reader and WS broadcaster."""

    def __init__(self):
        self.clients: set[websockets.WebSocketServerProtocol] = set()
        self.stream_info: dict | None = None   # set once connected
        self.connected: bool = False


# #######
# HELPERS
# #######

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

# ##########
# LSL READER
# ##########

async def lsl_reader(stream_name: str, state: BridgeState) -> None:
    """
    Continuously resolves the named LSL stream, reads samples, and
    broadcasts them.  Automatically reconnects on disconnect.
    """
    RESOLVE_TIMEOUT = 5.0   # seconds per resolve attempt
    PULL_TIMEOUT    = 2.0   # seconds to wait for a single sample

    while True:
        # resolv
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

        # connected 
        info = _stream_info_dict(inlet)
        state.stream_info = info
        state.connected = True

        log.info(f"Connected: {info}")
        await _broadcast(state, {"type": "connected", "stream": info})

        # read loop 
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

                await _broadcast(state, {
                    "type": "sample",
                    "value": value,
                    "timestamp": timestamp,
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

# ##################
# WEBSOCKETS HANDLER
# ##################

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


# ####
# MAIN
# ####

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