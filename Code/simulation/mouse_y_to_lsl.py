"""
mouse_y_to_lsl.py — Mouse Y → normalised breath signal streamed to LSL
=======================================================================
Maps the vertical mouse position to a normalised [0.0, 1.0] value and
pushes it as a single-channel LSL stream at a fixed sample rate.

Mapping:
    top of screen    → 1.0  (exhale / fish up)
    bottom of screen → 0.0  (inhale / fish down)

This lets you drive bioGame (or iBreath) manually with the mouse
without needing a physical respiration sensor.

Usage:
    python mouse_y_to_lsl.py
    python mouse_y_to_lsl.py --rate 100 --name resp_mouse
    python mouse_y_to_lsl.py --screen-height 1600   # override if auto-detect fails

Dependencies:
    pip install pylsl pynput
"""

import argparse
import time

from pylsl import StreamInfo, StreamOutlet, cf_float32
from pynput.mouse import Controller as MouseController


# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULT_NAME   = "resp_mouse"
DEFAULT_RATE   = 100     # Hz


# ── Screen height detection ───────────────────────────────────────────────────

def detect_screen_height() -> int:
    """Try multiple methods to get logical screen height in points/pixels."""
    # Method 1: tkinter (bundled with macOS Python, no extra deps)
    try:
        import tkinter as tk
        root = tk.Tk()
        root.withdraw()
        h = root.winfo_screenheight()
        root.destroy()
        if h > 0:
            return h
    except Exception:
        pass

    # Method 2: osascript (macOS only)
    try:
        import subprocess
        out = subprocess.check_output(
            ['osascript', '-e',
             'tell application "Finder" to get bounds of window of desktop'],
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode().strip()
        # Returns "0, 0, 2560, 1600"
        return int(out.split(',')[-1].strip())
    except Exception:
        pass

    print("[mouse_y] Warning: could not detect screen height — defaulting to 1080.")
    print("[mouse_y] Pass --screen-height <pixels> to override.")
    return 1080


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stream mouse Y as a normalised breath signal via LSL")
    p.add_argument("--rate",          type=int,   default=DEFAULT_RATE,
                   help=f"Sample rate in Hz (default {DEFAULT_RATE})")
    p.add_argument("--name",          type=str,   default=DEFAULT_NAME,
                   help=f"LSL stream name (default '{DEFAULT_NAME}')")
    p.add_argument("--screen-height", type=int,   default=0,
                   help="Override screen height in pixels (auto-detected if omitted)")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    screen_h = args.screen_height if args.screen_height > 0 else detect_screen_height()

    info = StreamInfo(
        name=args.name,
        type="Respiration",
        channel_count=1,
        nominal_srate=args.rate,
        channel_format=cf_float32,
        source_id=f"{args.name}_mouse",
    )
    outlet   = StreamOutlet(info)
    mouse    = MouseController()
    interval = 1.0 / args.rate

    print(f"[mouse_y] Streaming '{args.name}' at {args.rate} Hz")
    print(f"[mouse_y] Screen height: {screen_h} px")
    print("[mouse_y] Move mouse UP for exhale (1.0), DOWN for inhale (0.0)")
    print("[mouse_y] Press Ctrl+C to stop.\n")

    try:
        while True:
            loop_start = time.perf_counter()

            _, y   = mouse.position
            value  = max(0.0, min(1.0, 1.0 - y / screen_h))

            outlet.push_sample([value])

            elapsed = time.perf_counter() - loop_start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    except KeyboardInterrupt:
        print("\n[mouse_y] Stopped.")
