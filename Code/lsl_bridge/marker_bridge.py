import logging

import websockets
from pylsl import StreamOutlet

log = logging.getLogger("lsl_bridge")


async def marker_ws_handler(websocket, outlet: StreamOutlet) -> None:
    """
    Receives raw string markers from one WebSocket client and pushes each
    to the LSL outlet immediately (plain text, no JSON).
    """
    remote = websocket.remote_address
    log.info(f"Marker client connected: {remote}")
    try:
        async for raw in websocket:
            marker = raw if isinstance(raw, str) else raw.decode()
            outlet.push_sample([marker])
            log.info(f"Marker → LSL: {marker!r}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log.info(f"Marker client disconnected: {remote}")
