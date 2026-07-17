"""
send_marker.py — Interactive LSL marker sender
=======================================================================
Opens an LSL marker outlet and lets you type marker text at a prompt.
Each line you type is pushed as a single string sample on Enter.

Usage:
    python send_marker.py
    python send_marker.py --name my_markers

Dependencies:
    pip install pylsl
"""

import argparse

from pylsl import StreamInfo, StreamOutlet, cf_string


# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULT_NAME = "markers_sim"


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Send typed marker strings to LSL")
    p.add_argument("--name", type=str, default=DEFAULT_NAME,
                   help=f"LSL stream name (default '{DEFAULT_NAME}')")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    info = StreamInfo(
        name=args.name,
        type="Markers",
        channel_count=1,
        nominal_srate=0,
        channel_format=cf_string,
        source_id=f"{args.name}_sim",
    )
    outlet = StreamOutlet(info)

    print(f"[send_marker] Streaming '{args.name}' (Markers)")
    print("[send_marker] Type marker text and press Enter to send. Ctrl+C to stop.\n")

    try:
        while True:
            text = input("marker> ")
            if text == "":
                continue
            outlet.push_sample([text])
            print(f"[send_marker] Sent: {text!r}")

    except KeyboardInterrupt:
        print("\n[send_marker] Stopped.")
