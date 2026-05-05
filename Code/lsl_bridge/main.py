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
log = logging.getLogger("lsl_bridge")


async def main() -> None:
    state = BridgeState(label="resp")
    state.stream_change_event = asyncio.Event()

    asyncio.create_task(stream_discoverer(state))
    asyncio.create_task(lsl_reader(state))

    gaze_state = BridgeState(label="gaze")
    gaze_state.stream_change_event = asyncio.Event()
    asyncio.create_task(stream_discoverer(gaze_state))
    asyncio.create_task(lsl_reader(gaze_state))

    marker_info = StreamInfo(
        MARKER_STREAM_NAME, "Markers", 1, 0, "string", "respfish_markers")
    marker_outlet = StreamOutlet(marker_info)
    log.info(f"LSL marker outlet '{MARKER_STREAM_NAME}' ready")

    async def handler(websocket):
        await ws_handler(websocket, state)

    async def gaze_handler(websocket):
        await ws_handler(websocket, gaze_state)

    async def marker_handler(websocket):
        await marker_ws_handler(websocket, marker_outlet)

    log.info(f"Signal bridge: ws://{WS_HOST}:{WS_PORT}")
    log.info(f"Gaze bridge:   ws://{WS_HOST}:{GAZE_WS_PORT}")
    log.info(f"Marker bridge: ws://{WS_HOST}:{MARKER_WS_PORT}")
    async with websockets.serve(handler, WS_HOST, WS_PORT):
        async with websockets.serve(gaze_handler, WS_HOST, GAZE_WS_PORT):
            async with websockets.serve(marker_handler, WS_HOST, MARKER_WS_PORT):
                await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Bridge stopped.")
