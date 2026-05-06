# LabChart → LSL Bridge

Stream live physiological data from **ADInstruments LabChart 8** into **Lab Streaming Layer (LSL)** in real-time.

## How It Works

```
┌─────────────┐    USB     ┌──────────────┐   COM (bulk read)   ┌─────────────────┐  push_chunk()   ┌──────────────┐
│  PowerLab   │ ─────────► │  LabChart 8  │ ◄────────────────► │  labchart_to_   │ ──────────────► │ LabRecorder  │
│  Hardware   │            │  (Windows)   │   ~50× per second   │  lsl.py         │  w/ timestamps  │ / any inlet  │
└─────────────┘            └──────────────┘                     └─────────────────┘                 └──────────────┘
```

Every ~20 ms the bridge polls LabChart via COM for all new samples since the last read (e.g. ~10 samples at 500 Hz). It computes a hardware-accurate timestamp for each sample using the `TimestampMapper`, then pushes the whole chunk to LSL in one call. The consumer pulls samples one by one via `pull_sample()` and gets correct, evenly-spaced timestamps at the true hardware rate.

### Timestamp Accuracy

The `TimestampMapper` anchors one known tick index to an LSL clock reading, then computes every other sample's timestamp deterministically: `stamp(tick) = anchor_lsl + (tick - anchor_tick) / fs`. The anchor is refreshed every 5 seconds to absorb any slow drift between the PowerLab crystal and the PC clock.

## Latency

| Component              | Typical    | Notes                                    |
|------------------------|------------|------------------------------------------|
| LabChart buffering     | < 1 ms     | Negligible                               |
| **Polling interval**   | **~10 ms** | Average = poll_interval / 2              |
| LSL transport          | < 0.1 ms   | On localhost                             |
| **Total end-to-end**   | **~10–20 ms** | Tuneable via `--poll-interval`        |

## Requirements

| Requirement          | Details                                           |
|----------------------|---------------------------------------------------|
| **OS**               | Windows (COM automation is Windows-only)          |
| **LabChart**         | LabChart 8 (installed and running)                |
| **Python**           | 3.8 or newer                                      |
| **Python packages**  | `pywin32`, `pylsl`                                |

## Installation

```bash
pip install pywin32 pylsl
```

## Quick Start

1. **Open LabChart 8** with your PowerLab connected.
2. **Run the bridge:**
   ```bash
   python labchart_to_lsl.py
   ```
3. **Press Start** in LabChart — the bridge detects it and begins streaming.
4. **Verify** on any machine on the same network:
   ```bash
   python verify_lsl_stream.py
   ```
5. **Record with LabRecorder** or consume the stream with any LSL-compatible tool.

## Command-Line Options

```
  --name NAME              LSL stream name (default: LabChart)
  --type TYPE              LSL stream type: Phys, EEG, EMG, … (default: Phys)
  --source-id ID           Unique source identifier for LSL
  --poll-interval SEC      Polling interval in seconds (default: 0.02)
  --reanchor-interval SEC  Drift correction interval (default: 5.0)
  --timeout SEC            Wait for sampling timeout (default: 300)
  --log-level LEVEL        DEBUG, INFO, WARNING, ERROR (default: INFO)
```

### Examples

```bash
# Stream ECG data with a custom name
python labchart_to_lsl.py --name "PowerLab_ECG" --type "ECG"

# Lower latency (~5 ms avg) at the cost of more CPU
python labchart_to_lsl.py --poll-interval 0.01

# Debug mode
python labchart_to_lsl.py --log-level DEBUG
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Could not connect to LabChart` | Make sure LabChart 8 is running (not Lightning) |
| `No document is open` | Open or create a LabChart document first |
| `Waiting for sampling…` hangs | Press Start in LabChart |
| Stream not found by receiver | Check firewall — LSL uses UDP multicast for discovery |
| Latency too high | Decrease `--poll-interval` (e.g., `0.01` for ~5 ms avg) |

## License

MIT — use freely in your research.
