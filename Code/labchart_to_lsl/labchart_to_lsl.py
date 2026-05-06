"""
LabChart → LSL Bridge
=====================
Streams live physiological data from ADInstruments LabChart 8 into
Lab Streaming Layer (LSL) in real-time via the LabChart COM interface.

Architecture
------------
  1. A polling loop reads *chunks* of new samples from LabChart via COM
     (~50 Hz polling — fetches whatever has accumulated since the last read).
  2. Each chunk is pushed to LSL with per-sample hardware-accurate
     timestamps computed from the known sampling rate.

The TimestampMapper anchors LabChart's tick indices to the LSL clock,
giving every sample a precise timestamp spaced exactly 1/fs apart.
The anchor is refreshed periodically to absorb PC↔hardware clock drift.

Latency
-------
Average ≈ poll_interval / 2   (e.g. ~10 ms at the default 20 ms poll).
Worst case ≈ poll_interval     (e.g. ~20 ms).
No samples are ever lost — LabChart buffers everything in its recording.

Requirements
------------
- Windows  (COM automation is Windows-only)
- LabChart 8 installed and running with a document open
- Python 3.8+
- pip install pywin32 pylsl

Usage
-----
1. Open LabChart 8 and load/create a document with your PowerLab.
2. Run:   python labchart_to_lsl.py
3. Press Start in LabChart — the bridge detects it and begins streaming.
4. Use LabRecorder, MNE-Python, or any LSL inlet to receive the data.
5. Press Ctrl+C to stop.
"""

import argparse
import sys
import time
import logging
from dataclasses import dataclass
from typing import List

# ---------------------------------------------------------------------------
# Dependency check — give a clear message instead of a cryptic traceback
# ---------------------------------------------------------------------------

def _check_dependencies():
    missing = []
    try:
        import win32com.client  # noqa: F401
    except ImportError:
        missing.append("pywin32")
    try:
        import pylsl  # noqa: F401
    except ImportError:
        missing.append("pylsl")
    if missing:
        print(
            f"ERROR: Missing required packages: {', '.join(missing)}\n"
            f"Install them with:  pip install {' '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)

_check_dependencies()

import win32com.client  # noqa: E402
import pythoncom        # noqa: E402
from pylsl import StreamInfo, StreamOutlet, local_clock  # noqa: E402


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class Config:
    """All tuneable parameters in one place."""

    # LSL stream metadata
    stream_name: str = "LabChart"
    stream_type: str = "Phys"          # LSL content type (Phys, EEG, EMG, …)
    source_id: str = "labchart_bridge_001"

    # Polling behaviour
    poll_interval_sec: float = 0.02    # 20 ms → ~50 Hz polling
    # ↑ Reducing this lowers latency but increases CPU load.
    #   Values below ~0.005 (5 ms) are not recommended (COM overhead).

    # Timestamp re-anchoring interval (seconds).
    # The mapper periodically re-syncs the tick↔clock relationship to
    # compensate for any long-term drift between the PowerLab crystal
    # and the PC clock.
    reanchor_interval_sec: float = 5.0

    # How long to wait for LabChart to start sampling
    wait_for_sampling_timeout: float = 300.0  # 0 = wait forever

    # Logging
    log_level: str = "INFO"


# ---------------------------------------------------------------------------
# Timestamp mapper
# ---------------------------------------------------------------------------

class TimestampMapper:
    """
    Maps LabChart tick indices to LSL-clock timestamps.

    We know the exact sampling rate (fs) so the spacing between samples
    is precisely  dt = 1/fs.  We just need *one* anchor that relates a
    known tick index to an LSL clock reading.  From that anchor every
    other tick's timestamp is deterministic:

        stamp(tick) = anchor_lsl + (tick - anchor_tick) * dt

    The anchor is refreshed periodically (every ``reanchor_sec``) to
    absorb any slow drift between the PowerLab crystal and the PC clock.
    """

    def __init__(self, fs: float, reanchor_sec: float = 5.0):
        self._dt: float = 1.0 / fs
        self._reanchor_sec: float = reanchor_sec

        # Anchor: the LSL timestamp corresponding to anchor_tick
        self._anchor_tick: int = 0
        self._anchor_lsl: float = 0.0

        self._last_anchor_wall: float = 0.0   # monotonic time of last anchor
        self._anchored: bool = False

    def reset(self, fs: float) -> None:
        """Call when the sampling rate changes (new record)."""
        self._dt = 1.0 / fs
        self._anchored = False

    def needs_anchor(self) -> bool:
        if not self._anchored:
            return True
        return (time.monotonic() - self._last_anchor_wall) >= self._reanchor_sec

    def set_anchor(self, tick: int, lsl_time: float) -> None:
        """
        Establish (or refresh) the mapping:  tick ↔ lsl_time.

        Call this with the *newest* tick in a freshly fetched batch and
        an LSL clock reading taken just before the COM fetch.
        """
        self._anchor_tick = tick
        self._anchor_lsl = lsl_time
        self._last_anchor_wall = time.monotonic()
        self._anchored = True

    def stamp(self, tick: int) -> float:
        """Return the LSL timestamp for the given tick index."""
        return self._anchor_lsl + (tick - self._anchor_tick) * self._dt


# ---------------------------------------------------------------------------
# LabChart COM wrapper
# ---------------------------------------------------------------------------

class LabChartConnection:
    """Thin wrapper around the LabChart 8 COM automation interface."""

    def __init__(self):
        self.app = None
        self.doc = None

    def connect(self):
        """Connect to a running LabChart instance."""
        try:
            self.app = win32com.client.Dispatch("ADIChart.Application")
        except Exception as e:
            raise RuntimeError(
                "Could not connect to LabChart. "
                "Make sure LabChart 8 is running.\n"
                f"COM error: {e}"
            ) from e

        self.doc = self.app.ActiveDocument
        if self.doc is None:
            raise RuntimeError(
                "LabChart is running but no document is open. "
                "Please open or create a document first."
            )
        logging.info("Connected to LabChart document: %s", self.doc.Name)

    # -- Metadata queries ---------------------------------------------------

    @property
    def n_channels(self) -> int:
        return self.doc.NumberOfChannels

    @property
    def is_sampling(self) -> bool:
        return bool(self.doc.IsSampling)

    @property
    def current_record(self) -> int:
        """Active (latest) record/block number (1-based)."""
        return self.doc.NumberOfRecords

    def get_channel_name(self, channel_index: int) -> str:
        """channel_index is 0-based."""
        try:
            return self.doc.GetChannelName(channel_index)
        except Exception:
            return f"Ch{channel_index + 1}"

    def get_sampling_rate(self, record: int) -> float:
        """Return sampling rate (Hz) for the given record."""
        secs_per_tick = self.doc.GetRecordSecsPerTick(record)
        if secs_per_tick <= 0:
            raise ValueError(
                f"Invalid SecsPerTick ({secs_per_tick}) for record {record}"
            )
        return 1.0 / secs_per_tick

    def get_record_length_ticks(self, record: int) -> int:
        """Number of samples recorded so far in the given record."""
        return self.doc.GetRecordLength(record)

    def get_channel_data(self, channel: int, record: int,
                         start_tick: int, n_ticks: int):
        """
        Fetch raw data from one channel.

        Returns a tuple of floats (or a single float if n_ticks == 1).
        """
        return self.doc.GetChannelData(channel, record, start_tick, n_ticks)

    def get_units(self, channel: int, record: int) -> str:
        """Return the unit string for a channel."""
        try:
            return self.doc.GetUnits(channel, record)
        except Exception:
            return ""


# ---------------------------------------------------------------------------
# LSL outlet builder
# ---------------------------------------------------------------------------

def create_lsl_outlet(
    cfg: Config, lc: LabChartConnection, record: int
) -> StreamOutlet:
    """
    Build an LSL StreamInfo + StreamOutlet matching the current LabChart
    document layout.
    """
    n_ch = lc.n_channels
    fs = lc.get_sampling_rate(record)

    logging.info("Creating LSL outlet: %d channels @ %.1f Hz", n_ch, fs)

    info = StreamInfo(
        name=cfg.stream_name,
        type=cfg.stream_type,
        channel_count=n_ch,
        nominal_srate=fs,
        channel_format="float32",
        source_id=cfg.source_id,
    )

    # -- Channel metadata (XDF convention) ----------------------------------
    channels_xml = info.desc().append_child("channels")
    for i in range(n_ch):
        ch = channels_xml.append_child("channel")
        ch.append_child_value("label", lc.get_channel_name(i))
        ch.append_child_value("unit", lc.get_units(i, record))
        ch.append_child_value("type", cfg.stream_type)

    # -- Acquisition metadata -----------------------------------------------
    acq = info.desc().append_child("acquisition")
    acq.append_child_value("manufacturer", "ADInstruments")
    acq.append_child_value("software", "LabChart 8")
    acq.append_child_value("bridge", "labchart_to_lsl.py")

    # chunk_size=0 tells LSL we push individual samples (not fixed chunks).
    # max_buffered=360 keeps up to 6 minutes in the outlet buffer.
    outlet = StreamOutlet(info, chunk_size=0, max_buffered=360)
    logging.info(
        "LSL outlet live — visible on the network as '%s'", cfg.stream_name
    )
    return outlet


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def wait_for_sampling(lc: LabChartConnection, timeout: float):
    """Block until LabChart is actively sampling."""
    if lc.is_sampling:
        return
    logging.info(
        "Waiting for LabChart to start sampling…  (press Start in LabChart)"
    )
    t0 = time.time()
    while not lc.is_sampling:
        if timeout > 0 and (time.time() - t0) > timeout:
            raise TimeoutError(
                f"LabChart did not start sampling within {timeout:.0f} s. "
                "Press Start in LabChart, then re-run the bridge."
            )
        time.sleep(0.25)
    logging.info("LabChart is now sampling.")


# ---------------------------------------------------------------------------
# Main streaming loop
# ---------------------------------------------------------------------------

def stream_loop(cfg: Config, lc: LabChartConnection, outlet: StreamOutlet):
    """
    Core loop.

    1. Sleep for ``poll_interval_sec``.
    2. Ask LabChart how many new ticks are available.
    3. Fetch them in one bulk read per channel (fast — one COM call each).
    4. Compute per-sample timestamps and push the chunk to LSL.
    """
    record = lc.current_record
    fs = lc.get_sampling_rate(record)
    n_ch = lc.n_channels

    ts = TimestampMapper(fs, reanchor_sec=cfg.reanchor_interval_sec)

    # Start cursor at the current end so we only stream *new* data.
    cursor = lc.get_record_length_ticks(record)
    logging.info(
        "Streaming record %d  |  cursor=%d  |  %.1f Hz  |  %d ch",
        record, cursor, fs, n_ch,
    )

    samples_pushed = 0
    t_log = time.time()

    while True:
        try:
            # -- Still sampling? --------------------------------------------
            if not lc.is_sampling:
                logging.warning("LabChart stopped sampling.")
                break

            # -- Record changed? (user stopped + restarted) -----------------
            current_rec = lc.current_record
            if current_rec != record:
                logging.info(
                    "Record changed %d → %d, resetting.", record, current_rec
                )
                record = current_rec
                fs = lc.get_sampling_rate(record)
                ts.reset(fs)
                cursor = 0

            # -- Read the LSL clock *before* querying LabChart --------------
            #    This ensures our anchor timestamp is a conservative upper
            #    bound (the newest sample was acquired slightly *before* now).
            fetch_clock = local_clock()

            # -- How many new samples? --------------------------------------
            total_ticks = lc.get_record_length_ticks(record)
            new_ticks = total_ticks - cursor

            if new_ticks <= 0:
                time.sleep(cfg.poll_interval_sec)
                continue

            # -- Bulk-fetch from each channel -------------------------------
            channel_data: List[tuple] = []
            for ch in range(n_ch):
                raw = lc.get_channel_data(ch, record, cursor, new_ticks)
                # COM returns a bare float when n_ticks == 1
                if isinstance(raw, (int, float)):
                    raw = (raw,)
                channel_data.append(raw)

            # -- (Re-)anchor the timestamp mapper ---------------------------
            #    The *last* sample in this batch (tick = total_ticks - 1) is
            #    the most recent; it was acquired approximately at fetch_clock.
            if ts.needs_anchor():
                ts.set_anchor(total_ticks - 1, fetch_clock)
                logging.debug(
                    "Anchor: tick %d ↔ LSL %.4f", total_ticks - 1, fetch_clock
                )

            # -- Build chunk + per-sample timestamps, push in one call ------
            chunk = [
                [float(channel_data[ch][s]) for ch in range(n_ch)]
                for s in range(new_ticks)
            ]
            stamps = [ts.stamp(cursor + s) for s in range(new_ticks)]
            outlet.push_chunk(chunk, stamps)

            cursor = total_ticks
            samples_pushed += new_ticks

            # -- Periodic status log (every 5 s) ----------------------------
            if time.time() - t_log >= 5.0:
                newest_stamp = ts.stamp(cursor - 1)
                latency_ms = (local_clock() - newest_stamp) * 1000
                logging.info(
                    "Pushed %d total  |  batch=%d  |  %.1f Hz  |  "
                    "latency ≈ %.0f ms",
                    samples_pushed, new_ticks, fs, latency_ms,
                )
                t_log = time.time()

        except KeyboardInterrupt:
            raise
        except Exception:
            logging.exception("Error in streaming loop (will retry)")

        time.sleep(cfg.poll_interval_sec)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> Config:
    cfg = Config()
    p = argparse.ArgumentParser(
        description="Stream live LabChart 8 data to LSL.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--name", default=cfg.stream_name,
        help="LSL stream name",
    )
    p.add_argument(
        "--type", default=cfg.stream_type,
        help="LSL content type (Phys, EEG, EMG, …)",
    )
    p.add_argument(
        "--source-id", default=cfg.source_id,
        help="Unique source identifier for LSL",
    )
    p.add_argument(
        "--poll-interval", type=float, default=cfg.poll_interval_sec,
        help="Polling interval in seconds (lower = less latency, more CPU)",
    )
    p.add_argument(
        "--reanchor-interval", type=float, default=cfg.reanchor_interval_sec,
        help="Seconds between timestamp re-anchoring (drift correction)",
    )
    p.add_argument(
        "--timeout", type=float, default=cfg.wait_for_sampling_timeout,
        help="Seconds to wait for LabChart to start sampling (0 = forever)",
    )
    p.add_argument(
        "--log-level", default=cfg.log_level,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = p.parse_args()

    cfg.stream_name = args.name
    cfg.stream_type = args.type
    cfg.source_id = args.source_id
    cfg.poll_interval_sec = args.poll_interval
    cfg.reanchor_interval_sec = args.reanchor_interval
    cfg.wait_for_sampling_timeout = args.timeout
    cfg.log_level = args.log_level
    return cfg


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    cfg = parse_args()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level),
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    logging.info("=== LabChart → LSL Bridge ===")
    logging.info(
        "Config: name=%s  type=%s  poll=%.0f ms  reanchor=%.1f s",
        cfg.stream_name,
        cfg.stream_type,
        cfg.poll_interval_sec * 1000,
        cfg.reanchor_interval_sec,
    )

    # -- Connect to LabChart ------------------------------------------------
    lc = LabChartConnection()
    lc.connect()

    # -- Wait for sampling --------------------------------------------------
    wait_for_sampling(lc, cfg.wait_for_sampling_timeout)

    # -- Create LSL outlet --------------------------------------------------
    record = lc.current_record
    outlet = create_lsl_outlet(cfg, lc, record)

    # -- Stream! ------------------------------------------------------------
    try:
        while True:
            stream_loop(cfg, lc, outlet)
            # Sampling stopped — wait for it to resume.
            logging.info("Waiting for LabChart to resume sampling…")
            wait_for_sampling(lc, cfg.wait_for_sampling_timeout)

            # Recreate outlet if sampling rate changed.
            new_record = lc.current_record
            new_fs = lc.get_sampling_rate(new_record)
            old_fs = lc.get_sampling_rate(record)
            if new_fs != old_fs:
                logging.info(
                    "Sampling rate changed (%.1f → %.1f Hz), "
                    "recreating LSL outlet.",
                    old_fs, new_fs,
                )
                del outlet
                outlet = create_lsl_outlet(cfg, lc, new_record)
            record = new_record

    except (KeyboardInterrupt, TimeoutError) as e:
        if isinstance(e, TimeoutError):
            logging.error(str(e))
        else:
            logging.info("Stopped by user (Ctrl+C).")
    finally:
        logging.info("Bridge shut down. Goodbye!")


if __name__ == "__main__":
    main()
