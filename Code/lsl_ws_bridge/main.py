from marker_bridge import marker_ws_handler
from signal_bridge import BridgeState, stream_discoverer, lsl_reader, ws_handler
from config import WS_HOST, WS_PORT, GAZE_WS_PORT, MARKER_WS_PORT, MARKER_STREAM_NAME
from pylsl import StreamInfo, StreamOutlet
import websockets
import asyncio
import logging
import sys
from pathlib import Path

# Allow sibling modules to be imported when run as a script from any cwd
sys.path.insert(0, str(Path(__file__).parent))


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("lsl_ws_bridge")


async def main() -> None:
    # Each BridgeState holds the current LSL stream + a shared data buffer.
    # stream_discoverer watches for the LSL stream to appear/disappear;
    # lsl_reader pulls samples from it and stores them in the state.
    resp_state = BridgeState(label="resp")
    resp_state.stream_change_event = asyncio.Event()
    asyncio.create_task(stream_discoverer(resp_state))
    asyncio.create_task(lsl_reader(resp_state))

    gaze_state = BridgeState(label="gaze")
    gaze_state.stream_change_event = asyncio.Event()
    asyncio.create_task(stream_discoverer(gaze_state))
    asyncio.create_task(lsl_reader(gaze_state))

    # Marker outlet publishes string markers back onto LSL (write direction, not read)
    marker_info = StreamInfo(
        MARKER_STREAM_NAME, "Markers", 1, 0, "string", "respfish_markers")
    marker_outlet = StreamOutlet(marker_info)
    log.info(f"LSL marker outlet '{MARKER_STREAM_NAME}' ready")

    # Thin closures that bind each WebSocket handler to its corresponding state/outlet
    async def resp_handler(websocket):
        await ws_handler(websocket, resp_state)

    async def gaze_handler(websocket):
        await ws_handler(websocket, gaze_state)

    async def marker_handler(websocket):
        await marker_ws_handler(websocket, marker_outlet)

    log.info(f"Signal (resp) bridge: ws://{WS_HOST}:{WS_PORT}")
    log.info(f"Gaze bridge:   ws://{WS_HOST}:{GAZE_WS_PORT}")
    log.info(f"Marker bridge: ws://{WS_HOST}:{MARKER_WS_PORT}")
    
    # Start all three WebSocket servers concurrently
    servers = await asyncio.gather(
        websockets.serve(resp_handler, WS_HOST, WS_PORT),
        websockets.serve(gaze_handler, WS_HOST, GAZE_WS_PORT),
        websockets.serve(marker_handler, WS_HOST, MARKER_WS_PORT),
    )
    try:
        await asyncio.Future()
    finally:
        for server in servers:
            server.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Bridge stopped.")
