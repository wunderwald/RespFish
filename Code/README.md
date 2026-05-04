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
