"""
run_bridge.py
=============
Long-running process that owns an EyeLinkLSLBridge for the duration of a
session and exposes experimenter control over WebSocket, mirroring the
JSON-over-WebSocket convention used by ../lsl_ws_bridge/ so apps in ../app/
can talk to it the same way they already talk to that bridge.

On startup this script opens the PsychoPy window, connects to the EyeLink
Host, runs an initial calibration, and starts the LSL pump — then serves a
control WebSocket for the rest of the session (recalibrate, stop/start
recording, status, shutdown).

Control WebSocket (default ws://localhost:9002)
-------------------------------------------------
Client -> server (JSON, {"type": ...}):
  {"type": "calibrate"}   Recalibrate. If recording, pauses/resumes around
                           it automatically (see request_calibrate() in
                           eyelink_to_lsl.py); otherwise calibrates inline.
  {"type": "start"}       Start recording (no-op if already recording).
  {"type": "stop"}        Stop recording (no-op if not recording).
  {"type": "status"}      Request an immediate status snapshot.
  {"type": "shutdown"}    Stop recording, transfer the EDF file, disconnect
                           the tracker, and exit the process.

Server -> client (JSON):
  {"type": "status", "state": "connected"|"calibrating"|"calibrated"|
                               "recording"|"stopped"|"disconnected",
   "recording": bool, "host_ip": str, "edf_filename": str,
   "sample_rate": float, "screen_w": int, "screen_h": int}
  {"type": "error", "message": str}

A status snapshot is sent to every client on connect and broadcast to all
connected clients whenever the bridge's lifecycle state changes.

Run via start_bridge.bat (Windows) or directly:
  .venv/bin/python run_bridge.py --edf-filename sub01
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).parent))

import config
from eyelink_to_lsl import EyeLinkLSLBridge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("eyelink_to_lsl.run_bridge")


# ── Shared control state ────────────────────────────────────────────────────

class ControlState:
    def __init__(self):
        self.clients: set = set()
        self.last_state: str = "idle"
        self.loop: asyncio.AbstractEventLoop | None = None


def _status_payload(state: ControlState, bridge: EyeLinkLSLBridge) -> dict:
    return {
        "type": "status",
        "state": state.last_state,
        "recording": bridge.is_recording,
        "host_ip": bridge.host_ip,
        "edf_filename": bridge.edf_filename,
        "sample_rate": bridge.sample_rate,
        "screen_w": bridge.screen_w,
        "screen_h": bridge.screen_h,
    }


async def _broadcast_status(state: ControlState, bridge: EyeLinkLSLBridge) -> None:
    if not state.clients:
        return
    payload = json.dumps(_status_payload(state, bridge))
    await asyncio.gather(
        *[ws.send(payload) for ws in state.clients],
        return_exceptions=True,
    )


def _on_bridge_state(state: ControlState, bridge: EyeLinkLSLBridge, new_state: str) -> None:
    """
    Called by EyeLinkLSLBridge (possibly from its pump thread) whenever its
    lifecycle state changes. Before the control server is up, `state.loop`
    is still None, so this just records the state for the first status
    snapshot; once the loop is running, it schedules a thread-safe broadcast.
    """
    state.last_state = new_state
    log.info("Bridge state -> %s", new_state)
    if state.loop is not None:
        asyncio.run_coroutine_threadsafe(_broadcast_status(state, bridge), state.loop)


# ── PsychoPy window ──────────────────────────────────────────────────────────

def _make_window(args):
    from psychopy import visual

    return visual.Window(
        size=(args.screen_w, args.screen_h),
        screen=args.screen_index,
        fullscr=not args.windowed,
        units="pix",
    )


# ── Command handling ─────────────────────────────────────────────────────────

async def _handle_command(
    raw: str,
    websocket,
    state: ControlState,
    bridge: EyeLinkLSLBridge,
    stop_event: asyncio.Event,
) -> None:
    loop = asyncio.get_running_loop()

    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send(json.dumps({"type": "error", "message": "invalid JSON"}))
        return

    cmd = msg.get("type")

    if cmd == "calibrate":
        if bridge.is_recording:
            bridge.request_calibrate()  # thread-safe; picked up by the pump thread
        else:
            # No pump thread running to service it — calibrate inline. This
            # blocks the control server until the operator accepts on the
            # Host PC, same as the initial startup calibration.
            await loop.run_in_executor(None, bridge.calibrate)

    elif cmd == "start":
        if not bridge.is_recording:
            await loop.run_in_executor(None, bridge.start)

    elif cmd == "stop":
        if bridge.is_recording:
            await loop.run_in_executor(None, bridge.stop)

    elif cmd == "status":
        await websocket.send(json.dumps(_status_payload(state, bridge)))
        return

    elif cmd == "shutdown":
        log.info("Shutdown requested by client.")
        stop_event.set()
        return

    else:
        await websocket.send(json.dumps({"type": "error", "message": f"unknown command: {cmd!r}"}))
        return

    await websocket.send(json.dumps(_status_payload(state, bridge)))


async def _control_handler(
    websocket,
    state: ControlState,
    bridge: EyeLinkLSLBridge,
    stop_event: asyncio.Event,
) -> None:
    state.clients.add(websocket)
    remote = websocket.remote_address
    log.info("Control client connected: %s (total: %d)", remote, len(state.clients))

    await websocket.send(json.dumps(_status_payload(state, bridge)))

    try:
        async for raw in websocket:
            await _handle_command(raw, websocket, state, bridge, stop_event)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        state.clients.discard(websocket)
        log.info("Control client disconnected: %s (total: %d)", remote, len(state.clients))


# ── Setup + main loop ────────────────────────────────────────────────────────

def _setup_bridge(args, state: ControlState) -> EyeLinkLSLBridge:
    """
    Opens the PsychoPy window, connects to the EyeLink Host, and (per CLI
    flags) runs the initial calibration and starts recording. Runs entirely
    on the main thread, matching the thread affinity PsychopyCalibrationDisplay
    needs for its OpenGL calls.
    """
    window = _make_window(args)
    bridge = EyeLinkLSLBridge(
        host_ip=args.host_ip,
        screen_w=args.screen_w,
        screen_h=args.screen_h,
        window=window,
        sample_rate=args.sample_rate,
        edf_filename=args.edf_filename,
        on_state=lambda s: _on_bridge_state(state, bridge, s),
    )

    bridge.connect()
    if args.auto_calibrate:
        bridge.calibrate()
    if args.auto_start:
        bridge.start()

    return bridge


async def _serve(args, state: ControlState, bridge: EyeLinkLSLBridge) -> None:
    state.loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    async def handler(websocket):
        await _control_handler(websocket, state, bridge, stop_event)

    server = await websockets.serve(handler, args.control_host, args.control_port)
    log.info("Control API: ws://%s:%s", args.control_host, args.control_port)

    try:
        await stop_event.wait()
    finally:
        server.close()
        await server.wait_closed()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EyeLink -> LSL bridge with a WebSocket control API.")
    p.add_argument("--host-ip", default=config.HOST_IP)
    p.add_argument("--screen-w", type=int, default=config.SCREEN_W)
    p.add_argument("--screen-h", type=int, default=config.SCREEN_H)
    p.add_argument("--screen-index", type=int, default=config.SCREEN_INDEX)
    p.add_argument("--sample-rate", type=float, default=config.SAMPLE_RATE)
    p.add_argument("--edf-filename", default=config.EDF_FILENAME,
                    help="Base name of the Host PC EDF file (max 8 chars); usually the participant ID.")
    p.add_argument("--control-host", default=config.CONTROL_WS_HOST)
    p.add_argument("--control-port", type=int, default=config.CONTROL_WS_PORT)
    p.add_argument("--windowed", action="store_true",
                    help="Open the calibration window non-fullscreen (for testing without the tracking display).")
    p.add_argument("--no-auto-calibrate", dest="auto_calibrate", action="store_false",
                    default=config.AUTO_CALIBRATE,
                    help="Skip the initial calibration; trigger it later via a 'calibrate' control command.")
    p.add_argument("--no-auto-start", dest="auto_start", action="store_false",
                    default=config.AUTO_START,
                    help="Don't start recording automatically; trigger it later via a 'start' control command.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    state = ControlState()
    bridge: EyeLinkLSLBridge | None = None

    try:
        bridge = _setup_bridge(args, state)
        asyncio.run(_serve(args, state, bridge))
    except KeyboardInterrupt:
        log.info("Interrupted.")
    finally:
        # The event loop is closed once asyncio.run() returns; clear the
        # reference so any further on_state callbacks (from stop/disconnect
        # below) don't try to broadcast into a dead loop.
        state.loop = None
        if bridge is not None:
            if bridge.is_recording:
                bridge.stop()
            bridge.disconnect()
        log.info("Bridge shut down.")


if __name__ == "__main__":
    main()
