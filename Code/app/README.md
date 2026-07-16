# app

Electron app for real-time respiration biofeedback experiments.

Receives a normalized breath signal `[0, 1]` over WebSocket from `lsl_ws_bridge/` and renders one of several experiment frontends.

## Setup

```bash
npm install
```

## Run

```bash
npm start              # start screen — choose a frontend in the UI
```

Direct-launch shortcuts (skip the start screen):

```bash
npm run ibreath       # iBreath experiment
npm run bioGame       # biofeedback breath game
npm run trainingGame  # breath training game
npm run baseline      # resting-state baseline
npm run visualizer    # real-time waveform
```

---

## Modules

| Module | Description | Docs |
|---|---|---|
| iBreath | Interoception experiment | [docs/ibreath.md](docs/ibreath.md) |
| bioGame | Biofeedback game | [docs/bioGame.md](docs/bioGame.md) |
| trainingGame | Slow breathing training game | [docs/trainingGame.md](docs/trainingGame.md) |
| baseline | Resting-state recording | [docs/baseline.md](docs/baseline.md) |
| visualizer | Live signal waveform viewer | [docs/visualizer.md](docs/visualizer.md) |
| signal | Signal processing utilities | [docs/signal.md](docs/signal.md) |
| calibration | Respiration signal calibration | [docs/calibration.md](docs/calibration.md) |
| stream | LSL bridge and marker output | [docs/stream.md](docs/stream.md) |
| webgazer | Webcam-based gaze tracking | [docs/webgazer.md](docs/webgazer.md) |

---

## Add a frontend

1. Create `modules/<name>/<name>.js` exporting a default class:

```js
pushSample(value)         // called on every breath sample [0, 1]
setStatus({ type, text }) // called on stream connection changes
```

2. Create `styles/<name>.css`.
3. Add the path to `FRONTEND_PATHS` in `renderer.js`.
4. Add a script entry to `package.json`: `"<name>": "FRONTEND=<name> electron ."`.
