# simulation

Lightweight LSL signal sources for development and testing — no hardware required.

| Script | Stream type | Description |
|---|---|---|
| `simulate_resp.py` | Respiration (1ch) | Physiological breath model with rate variability, amplitude jitter, and additive noise |
| `simulate_gaze.py` | Gaze (2ch x/y) | Bandlimited random walk producing naturalistic scan-path trajectories |
| `mic_breath.py` | Respiration (1ch) | Live mic input — extracts breath envelope and streams it to LSL |
| `mouse_y_to_lsl.py` | Respiration (1ch) | Mouse Y position mapped to `[0, 1]` and streamed to LSL |

All scripts require `pylsl` (`pip install pylsl`). Use the `.venv` at the repo root.

## Usage

```bash
# Simulated breath signal
python simulate_resp.py [--bpm 12] [--rate 100] [--name resp_belt_sim] [--drift 2]

# Simulated gaze
python simulate_gaze.py [--rate 60] [--name gaze_sim]

# Microphone breath
python mic_breath.py

# Mouse control (useful for manually testing app responses)
python mouse_y_to_lsl.py
```
