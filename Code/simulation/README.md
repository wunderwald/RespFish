# simulation

Lightweight LSL signal sources for development and testing.

| Script | Stream type | Description |
|---|---|---|
| `simulate_resp.py` | Respiration (1ch) | Physiological breath model with rate variability, amplitude jitter and additive noise |
| `simulate_gaze.py` | Gaze (2ch x/y) | Bandlimited random walk producing random normalized screen coords |
| `mic_breath.py` | Respiration (1ch) | Live mic input — extracts breath envelope and streams it to LSL |
| `mouse_y_to_lsl.py` | Respiration (1ch) | Mouse Y position mapped to `[0, 1]` and streamed to LSL |
| `send_marker.py` | Markers (1ch string) | Interactive prompt — type text, Enter sends it as an LSL marker |

All scripts require `pylsl` (`pip install pylsl`). 

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

# Interactive marker sender
python send_marker.py [--name markers_sim]
```
