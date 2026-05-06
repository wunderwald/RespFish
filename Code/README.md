# RespFish

Electron app for real-time respiration biofeedback experiments.

```
resp/ → LSL → lsl_bridge/ → WebSocket → app/
```

## Setup

```bash
# Python dependencies (one-time)
python3 -m venv .venv && source .venv/bin/activate
pip install pylsl websockets sounddevice numpy

# Node dependencies (one-time)
cd app && npm install
```

## Run

```bash
# Activate python environment
source .venv/bin/activate

# Pick a resp signal source
cd resp && python simulate_lsl.py --bpm 14   # synthetic
cd resp && python mic_breath.py              # microphone

# Optionally simulate gaze
cd gaze && python simulate_gaze.py

# Launch the app
cd app && npm start              # start screen — choose a frontend in the UI
```

Direct-launch shortcuts (skip the start screen):

```bash
cd app && npm run ibreath       # iBreath experiment
cd app && npm run bioGame       # biofeedback breath game
cd app && npm run trainingGame  # breath training game
cd app && npm run baseline      # resting-state baseline
cd app && npm run visualizer    # real-time waveform
```

---

## Modules

| Module | Description | Docs |
|---|---|---|
| iBreath | Interoception experiment | [app/docs/ibreath.md](app/docs/ibreath.md) |
| bioGame | Biofeedback game | [app/docs/bioGame.md](app/docs/bioGame.md) |
| trainingGame | Slow breathing training game | [app/docs/trainingGame.md](app/docs/trainingGame.md) |
| baseline | Resting-state recording | [app/docs/baseline.md](app/docs/baseline.md) |
| visualizer | Live signal waveform viewer | [app/docs/visualizer.md](app/docs/visualizer.md) |
| signal | Signal processing utilities | [app/docs/signal.md](app/docs/signal.md) |
| stream | LSL bridge and marker output | [app/docs/stream.md](app/docs/stream.md) |
| webgazer | Webcam-based gaze tracking | [app/docs/webgazer.md](app/docs/webgazer.md) |

---

## Add a frontend

1. Create `app/modules/<name>/<name>.js` exporting a default class:

```js
pushSample(value)         // called on every breath sample [0, 1]
setStatus({ type, text }) // called on stream connection changes
```

2. Create `app/styles/<name>.css`.
3. Add the path to `FRONTEND_PATHS` in `app/renderer.js`.
4. Add a script entry to `app/package.json`: `"<name>": "FRONTEND=<name> electron ."`.

## Add a signal source

Any script that opens a `pylsl.StreamOutlet` and pushes normalized `[0, 1]` floats works. The bridge discovers streams by name automatically.
