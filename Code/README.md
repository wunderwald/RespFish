# RespFish

Electron app for real-time respiration biofeedback experiments.

```
resp/ → LSL → lsl_bridge/ → WebSocket → app/
```

## Setup

```bash
# Python dependencies (one-time)
python3 -m venv .venv
source .venv/bin/activate
pip install pylsl websockets sounddevice numpy

# Node dependencies (one-time)
cd app && npm install
```

## Run

```bash
# Pick a resp signal source
cd resp && python simulate_lsl.py --bpm 14   # synthetic
cd resp && python mic_breath.py              # microphone

# Optionally simulate gaze (for testing without an eye-tracker)
cd gaze && python simulate_gaze.py

# Launch the app with a specific frontend (bridge starts automatically)
cd app && npm run ibreath       # iBreath experiment (default)
cd app && npm run bioGame       # biofeedback breath game
cd app && npm run visualizer    # real-time waveform
cd app && npm run trainingGame  # breath-controlled training game
cd app && npm run gazetest      # gaze debug overlay
```

`npm start` (no frontend arg) also launches ibreath.

## Add a frontend

1. Create `app/modules/<name>/<name>.js` exporting a default class:

```js
pushSample(value)         // called on every breath sample [0, 1]
setStatus({ type, text }) // called on stream connection changes
```

2. Create `app/styles/<name>.css`.
3. Add the path to `FRONTEND_PATHS` in `app/renderer.js`.
4. Add a script entry to `app/package.json`: `"<name>": "FRONTEND=<name> electron ."`.

The new frontend is then launchable with `npm run <name>`.

## Add a signal source

Any script that opens a `pylsl.StreamOutlet` and pushes normalized `[0, 1]` floats works. The bridge discovers streams by name automatically.

## Data output (bioGame)

Written to `app/bioGameData/<SUBJECT_CODE>/`. See [docs/bioGame.md](docs/bioGame.md) for full column descriptions.

- `block_<N>_frames.csv` — 20 Hz frame data (breath, fish position, target curve)
- `block_<N>_events.csv` — timestamped events (starfish collected/missed, block end)

## Data output (iBreath)

Written to `app/iBreathData/<SUBJECT_CODE>/`:
- `trialData.csv` — one row per trial, including stimulus rectangle (`stimX0/Y0/X1/Y1`, normalized)
- `frameData_N.csv` — per-frame breath, stimulus, and (if configured) gaze values for trial N

## Experimenter window (iBreath)

When `npm run ibreath` starts, a second **experimenter window** opens automatically. It contains the HUD controls (subject code, group, Start/Next/Abort buttons), both stream selectors, and the experiment clocks. The main window shows only the participant scene. Both windows can be moved to separate screens.

## Gaze input (iBreath)

The experimenter window has a **gaze** stream selector (alongside the resp stream selector). It connects to the LSL bridge on port 8766 (configured via `GAZE_STREAM_URL` in `config.js`) and lists all available LSL streams. Select the eye-tracker stream before pressing Start — the dropdowns lock once calibration begins. If no gaze stream is selected or the bridge is unreachable, gaze data is simply omitted.

The bridge expects a multi-channel LSL stream; gaze coordinates are read from channels 0 (X) and 1 (Y), both normalized `[0, 1]`. `gaze/simulate_gaze.py` provides a synthetic stream for testing.

When a gaze stream is active, `frameData_N.csv` gains two columns: `gazeX` and `gazeY`. Frames where no data has arrived yet record empty values.

Set `DEBUG_GAZE: true` in `config.js` to overlay a dot at the current gaze position on the scene canvas.

`trialData.csv` always includes `stimX0, stimY0, stimX1, stimY1` — the normalized bounding rectangle of the half-screen in which the cloud stimulus appeared — for postprocessing gaze within the stimulus region.

## Marker output (iBreath)

iBreath sends string markers over a WebSocket for LSL forwarding. Configure in `app/modules/ibreath/config.js`:

```js
SEND_MARKERS:       true,
MARKER_STREAM_URL:  'ws://localhost:9001',
```

Markers sent (all trial-indexed as `_tN` where N is 0-based):

| Marker | Event |
|---|---|
| `calibration_start` / `calibration_end` | calibration phase |
| `display_start_tN` | pre-trial animation begins |
| `trial_start_tN` / `trial_end_tN` / `trial_abort_tN` | trial lifecycle |
| `flash_start_tN` / `flash_end_tN` | flash image onset / offset |
| `response_start_tN` | question screen appears |
| `response_yes_tN` / `response_no_tN` / `response_timeout_tN` | subject response |
| `iti_start_tN` | inter-trial interval begins |
| `experiment_done` | all trials complete |

The WebSocket server on `MARKER_STREAM_URL` is responsible for forwarding these strings to LSL. `SEND_MARKERS: false` disables all marker output with zero overhead.
