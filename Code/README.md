# RespFish

Electron app for real-time respiration biofeedback experiments.

```
resp/ → LSL → lsl_bridge/ → WebSocket → app/
```

## Running

```bash
# Start a signal source (pick one)
cd resp && python simulate_lsl.py --bpm 14   # no hardware
cd resp && python mic_breath.py              # microphone

# Start the app (spawns the bridge automatically)
cd app && npm start
```

The bridge can be started manually for debugging: `cd lsl_bridge && python main.py`

---

## Modules

**`resp/`** — Signal sources. Publish float samples in `[0.0, 1.0]` via LSL.
- `simulate_lsl.py` — synthetic breath signal (`--bpm`, `--rate`, `--name`)
- `mic_breath.py` — live microphone input

**`lsl_bridge/`** — Discovers LSL streams and relays samples to the app over WebSocket (`ws://localhost:8765`).

**`app/`** — Electron frontend. `renderer.js` loads the active frontend and wires it to the stream.

---

## Switching frontends

Change `FRONTEND` at the top of `app/renderer.js`:

```js
const FRONTEND = 'ibreath'; // 'visualizer' | 'game' | 'ibreath' | 'gazetest'
```

---

## Adding a frontend

1. Create `app/modules/<name>/<name>.js` and `app/styles/<name>.css`.
2. Export a default class with two methods:

```js
pushSample(value)         // called on every breath sample [0, 1]
setStatus({ type, text }) // called on connection state changes
```

3. Add the name to `FRONTEND_PATHS` in `renderer.js`.

---

## Adding a signal source

Any script that opens a `pylsl.StreamOutlet` and pushes normalized float samples (`[0.0, 1.0]`) will work. The bridge discovers streams by name automatically.

---

## Data output (iBreath)

Saved to `app/subjectData/<SUBJECT_CODE>/`:
- `trialData.csv` — one row per trial
- `frameData_N.csv` — per-frame breath and stimulus values for trial N
