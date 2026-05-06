"""
LSL Receiver / Verification Tool
=================================
Connects to the LabChart LSL stream and prints incoming samples.
Useful for verifying that the bridge is working.

Usage:
    python verify_lsl_stream.py
    python verify_lsl_stream.py --name "LabChart" --duration 10
"""

import argparse
import sys
import time

try:
    from pylsl import StreamInlet, resolve_stream, local_clock
except ImportError:
    print("ERROR: pylsl not installed. Run: pip install pylsl", file=sys.stderr)
    sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="Verify an LSL stream from the LabChart bridge.")
    p.add_argument("--name", default="LabChart", help="LSL stream name to look for")
    p.add_argument("--duration", type=float, default=0,
                   help="Seconds to receive (0 = until Ctrl+C)")
    p.add_argument("--quiet", action="store_true",
                   help="Only print summary stats, not every sample")
    args = p.parse_args()

    print(f"Looking for LSL stream '{args.name}' on the network…")
    streams = resolve_stream("name", args.name, timeout=10.0)
    if not streams:
        print(f"ERROR: No stream named '{args.name}' found.", file=sys.stderr)
        sys.exit(1)

    info = streams[0]
    print(f"\nFound stream:")
    print(f"  Name:          {info.name()}")
    print(f"  Type:          {info.type()}")
    print(f"  Channels:      {info.channel_count()}")
    print(f"  Sampling rate: {info.nominal_srate()} Hz")
    print(f"  Source ID:     {info.source_id()}")
    print()

    inlet = StreamInlet(info, max_buflen=360)

    # Read channel labels from metadata
    ch_xml = inlet.info().desc().child("channels")
    labels = []
    ch = ch_xml.child("channel")
    while ch.name() == "channel":
        labels.append(ch.child_value("label"))
        ch = ch.next_sibling()
    if labels:
        print(f"  Channel labels: {labels}")
        print()

    print("Receiving samples (Ctrl+C to stop)…\n")

    n_samples = 0
    t_start = time.time()
    t_first_sample = None
    t_last_log = time.time()

    try:
        while True:
            sample, timestamp = inlet.pull_sample(timeout=1.0)
            if sample is None:
                continue

            n_samples += 1
            if t_first_sample is None:
                t_first_sample = time.time()

            if not args.quiet:
                # Print first few values + timestamp
                preview = "  ".join(f"{v:+9.4f}" for v in sample[:4])
                if len(sample) > 4:
                    preview += f"  … ({len(sample)} ch)"
                print(f"  t={timestamp:.4f}  {preview}")

            # Periodic stats
            if time.time() - t_last_log >= 2.0:
                elapsed = time.time() - (t_first_sample or t_start)
                rate = n_samples / elapsed if elapsed > 0 else 0
                print(f"  --- {n_samples} samples received, "
                      f"effective rate: {rate:.1f} Hz ---")
                t_last_log = time.time()

            # Duration limit
            if args.duration > 0 and (time.time() - t_start) >= args.duration:
                print(f"\nDuration limit ({args.duration}s) reached.")
                break

    except KeyboardInterrupt:
        print("\nStopped.")

    elapsed = time.time() - t_start
    rate = n_samples / elapsed if elapsed > 0 else 0
    print(f"\nSummary: {n_samples} samples in {elapsed:.1f}s → {rate:.1f} samples/s")


if __name__ == "__main__":
    main()
