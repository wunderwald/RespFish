# RespFish

A desktop application for real-time respiration signal visualization and experimentation. Built as an Electron app with a Python backend, it is designed for research contexts where breath data needs to be captured, relayed, and displayed interactively.

---

## System Overview

```
Signal source (resp/)
    → LSL network protocol
        → Bridge (lsl_bridge/)
            → WebSocket
                → App (app/)
                    → Frontend (visualizer, game, ibreath, ...)
```

Each layer is independent and replaceable. Any device that publishes an LSL stream works as a signal source — no changes to the rest of the stack required.

---

## Modules

### `resp/` — Signal Sources

Provides respiration data as an LSL stream. Currently, the following implementations are included:

**`mic_breath.py`** — captures breath from the microphone in real time.

Records audio, bandpass-filters, extracts an RMS envelope, normalizes to [0, 1], and publishes via LSL.

**`simulate_lsl.py`** — generates a synthetic breath signal for testing without hardware.

Command-line options: `--bpm` (default 12), `--rate` (default 100 Hz), `--name` (default `resp_belt_sim`).

Both scripts publish to LSL with the same interface, so they are drop-in replacements for each other.

> **Creating for new sources:** Any script that opens an `pylsl.StreamOutlet` and pushes float samples will work. The bridge discovers streams by name — no configuration needed on the app side.

---

### `lsl_bridge/` — LSL-to-WebSocket Bridge

**`main.py`** — a Python asyncio server that discovers LSL streams on the network and relays samples to WebSocket clients.

**What it does:**

1. Polls LSL every 2–3 seconds and broadcasts the list of available streams to all connected clients.
2. When a client selects a stream by name, opens a pull inlet and forwards samples as JSON messages.
3. Reconnects automatically if a stream disappears.

**Message protocol (JSON over WebSocket):**

| Direction | Message |
|-----------|---------|
| Server → Client | `{ type: "streams", streams: [...] }` — available streams |
| Server → Client | `{ type: "sample", value: float, timestamp: float }` |
| Server → Client | `{ type: "connected", stream: {...} }` |
| Server → Client | `{ type: "disconnected", reason: string }` |
| Client → Server | `{ type: "select_stream", name: string }` |

Listens on `ws://localhost:8765` by default.

> **Adding new features:** The bridge is intentionally thin — it relays raw samples and nothing else. Signal processing (smoothing, normalization, feature extraction) lives in the app layer. To add a new message type (e.g., stream metadata, event markers), extend `ws_handler()` and `read_one_stream()` in `main.py`.

> **Key design decision:** LSL calls block the thread. The bridge runs them in `asyncio.get_event_loop().run_in_executor()` so the event loop stays non-blocking. Keep this pattern when adding new LSL interactions.

---

### `app/` — Electron Frontend

A multi-frontend desktop application. The active frontend is swappable at startup; all frontends receive the same breath stream via a shared event interface.

#### Startup sequence

1. **`main.js`** (Electron main process) spawns the Python LSL to WS bridge as a subprocess, creates the browser window, and requests camera permissions (needed for eye tracking).
2. **`renderer.js`** (orchestrator) injects the frontend's stylesheet, optionally runs gaze calibration, dynamically imports the frontend module, instantiates `StreamManager`, and connects its events to the frontend.

To switch frontends, change the `FRONTEND` constant at the top of `renderer.js`:

```javascript
const FRONTEND = 'ibreath'; // 'visualizer' | 'game' | 'ibreath' | 'gazetest'
```

#### StreamManager (`modules/stream.js`)

Owns the WebSocket connection to the bridge and emits three events:

| Event | Payload | Meaning |
|-------|---------|---------|
| `sample` | `number` | A new breath value arrived |
| `status` | `{ type, text }` | Connection state changed |
| `streams` | `string[]` | Available LSL streams changed |

A stream selector dropdown is injected into the UI automatically.

#### Frontend interface

Every frontend module must export a class with two methods:

```javascript
pushSample(value)        // called on every breath sample
setStatus({ type, text }) // called on connection state changes
```

To add a new frontend: create `modules/myfrontend.js` and `styles/myfrontend.css`, implement the two methods, and add the name to the `FRONTEND` options.

#### Built-in frontends

| Module | Description |
|--------|-------------|
| `visualizer.js` | Scrolling waveform + animated fish avatar |
| `game.js` | Guitar-Hero-style cloud game controlled by breath |
| `ibreath.js` | Interoception experiment with gaze tracking |
| `gazetest.js` | Eye-tracking calibration validation utility |

#### Data output (iBreath)

IBreath saves experiment data to `app/subjectData/<SUBJECT_CODE>/`:

- `frameData_*.csv` — per-frame measurements (gaze position, breath level, stimulus value).
- `trialData.csv` — aggregated per-trial metrics.

File I/O is routed through `preload.js` via Electron IPC. The renderer process has no direct filesystem access.

> **Key design decision:** Frontends are isolated from each other and from the Electron main process. Adding or modifying a frontend cannot break the bridge, the stream connection, or other frontends.

---

## Running the System

```bash
# Option A: use the simulator (no hardware needed)
cd resp
python simulate_lsl.py --bpm 14

# Option B: use the microphone
cd resp
python mic_breath.py

# Start the app (bridge is spawned automatically)
cd app
npm start
```

The bridge can also be started manually for debugging:

```bash
cd lsl_bridge
python main.py
```

The app connects to `ws://localhost:8765`. Any LSL stream visible on the local network will appear in the stream selector dropdown once discovered.
