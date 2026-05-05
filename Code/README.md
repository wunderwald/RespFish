# RespFish

Electron app for real-time respiration biofeedback experiments.

```
resp/ → LSL → lsl_bridge/ → WebSocket → app/
```

## Run

```bash
# Pick a signal source
cd resp && python simulate_lsl.py --bpm 14   # synthetic
cd resp && python mic_breath.py              # microphone

# Launch the app (starts the bridge automatically)
cd app && npm start
```

## Switch frontend

Change `FRONTEND` at the top of `app/renderer.js`:

```js
const FRONTEND = 'ibreath'; // 'visualizer' | 'game' | 'ibreath' | 'gazetest'
```

## Add a frontend

1. Create `app/modules/<name>/<name>.js` exporting a default class:

```js
pushSample(value)         // called on every breath sample [0, 1]
setStatus({ type, text }) // called on stream connection changes
```

2. Create `app/styles/<name>.css`.
3. Add the path to `FRONTEND_PATHS` in `app/renderer.js`.

## Add a signal source

Any script that opens a `pylsl.StreamOutlet` and pushes normalized `[0, 1]` floats works. The bridge discovers streams by name automatically.

## Data output (iBreath)

Written to `app/subjectData/<SUBJECT_CODE>/`:
- `trialData.csv` — one row per trial
- `frameData_N.csv` — per-frame breath and stimulus values for trial N

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
