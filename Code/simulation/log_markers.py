"""
log_markers.py — Universal LSL marker logger
=======================================================================
Discovers every LSL stream of a given type (default "Markers") on the
network and logs incoming samples to the console, and optionally to a
CSV file. The network is rescanned on an interval, so marker streams
that appear after this script starts are picked up automatically —
no restart needed.

Usage:
    python log_markers.py
    python log_markers.py --type Markers --interval 2 --out markers_log.csv

Dependencies:
    pip install pylsl
"""

import argparse
import csv
import threading
import time
from datetime import datetime, timezone

from pylsl import StreamInlet, resolve_streams


# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULT_STREAM_TYPE   = "Markers"
DEFAULT_SCAN_INTERVAL = 2.0   # seconds between rediscovery scans
PULL_TIMEOUT          = 0.5   # seconds — bounds how quickly a stopped logger exits


# ── Per-stream logger ────────────────────────────────────────────────────────

class StreamLogger:
    """Pulls samples from one inlet on a background thread until stopped."""

    def __init__(self, info, csv_writer, writer_lock):
        self.name        = info.name()
        self.source_id   = info.source_id() or "n/a"
        self._info       = info
        self._csv_writer = csv_writer
        self._writer_lock = writer_lock
        self._stop        = threading.Event()
        self.thread        = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        try:
            inlet = StreamInlet(self._info, max_buflen=360)
        except Exception as e:
            print(f"[log_markers] Failed to open inlet for '{self.name}': {e}")
            return

        print(f"[log_markers] Logging stream '{self.name}' (source_id={self.source_id})")

        while not self._stop.is_set():
            try:
                sample, timestamp = inlet.pull_sample(timeout=PULL_TIMEOUT)
            except Exception as e:
                print(f"[log_markers] Lost stream '{self.name}': {e}")
                break
            if sample is None:
                continue

            wall  = datetime.now(timezone.utc).isoformat()
            value = sample[0] if len(sample) == 1 else sample
            print(f"[{wall}] {self.name}: {value!r}  (lsl_t={timestamp:.4f})")

            if self._csv_writer is not None:
                with self._writer_lock:
                    self._csv_writer.writerow([wall, f"{timestamp:.6f}", self.name, value])

        print(f"[log_markers] Stopped logging '{self.name}'")


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Log events from all LSL marker streams on the network")
    p.add_argument("--type", type=str, default=DEFAULT_STREAM_TYPE,
                   help=f"LSL stream type to log (default '{DEFAULT_STREAM_TYPE}')")
    p.add_argument("--interval", type=float, default=DEFAULT_SCAN_INTERVAL,
                   help=f"Seconds between rediscovery scans (default {DEFAULT_SCAN_INTERVAL})")
    p.add_argument("--out", type=str, default=None,
                   help="Optional CSV file to append logged events to")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    csv_file    = None
    csv_writer  = None
    writer_lock = threading.Lock()
    if args.out:
        csv_file   = open(args.out, "a", newline="")
        csv_writer = csv.writer(csv_file)
        if csv_file.tell() == 0:
            csv_writer.writerow(["wall_time", "lsl_timestamp", "stream", "marker"])

    print(f"[log_markers] Watching for '{args.type}' streams "
          f"(rescanning every {args.interval}s). Press Ctrl+C to stop.\n")

    active = {}  # uid -> StreamLogger

    try:
        while True:
            for info in resolve_streams(wait_time=args.interval):
                if info.type() != args.type:
                    continue
                uid = info.uid()
                if uid in active:
                    continue
                logger = StreamLogger(info, csv_writer, writer_lock)
                active[uid] = logger
                logger.start()

    except KeyboardInterrupt:
        print("\n[log_markers] Stopping…")

    finally:
        for logger in active.values():
            logger.stop()
        for logger in active.values():
            logger.thread.join(timeout=2.0)
        if csv_file:
            csv_file.close()
