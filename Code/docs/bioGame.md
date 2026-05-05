# bioGame — Biofeedback Breath Game

A breath-controlled underwater game. The participant guides a puffer fish up and down by breathing, collecting starfish that drift across the screen along a sinusoidal target curve.

---

## Starting a session

```bash
cd app && npm run bioGame
```

Two windows open:
- **Scene window** — shown on the participant's screen (fullscreen underwater world)
- **Experimenter window** — your control panel, can stay on the operator screen

---

## Experimenter controls

| Control | What it does |
|---|---|
| **Subject** | Type the subject code before pressing Start. Locked once calibration begins. |
| **Group** | *Target (slow 6 BPM)* — fish follows a 6 BPM breath curve, starfish appear on that curve. *Control (natural)* — curve uses the participant's natural BPM (set the BPM field). |
| **Natural BPM** | Only visible in the natural condition. Sets the target curve frequency. |
| **Show target curve** | Overlays the sinusoidal target curve on screen (for debugging / operator monitoring). |
| **Cal secs** | How many seconds to calibrate the breath signal (default 10 s). Calibration captures the participant's breathing range. |
| **Data dir** | Folder where CSV files are saved. Click **…** to pick a different folder. Default: `bioGameData/` inside the app folder. |
| **Score** | Live count of starfish collected in the current game. |
| **Start** | Begins calibration. Requires a connected resp stream. |
| **Start Game 2** | Appears after Game 1 ends. Starts the second block (also triggered by Space). |
| **Abort** | Ends the current game immediately and saves data. |

**Keyboard shortcuts** (experimenter window focused):
- `Space` — advance (start Game 2 / confirm ready state)
- `Escape` — abort current game

---

## Session flow

```
stream ready → [Start] → Calibration (10 s)
                              ↓
                         READY screen  → [Space / Start]
                              ↓
                         Countdown (3-2-1-GO)
                              ↓
                       Game 1  (5 min)
                              ↓
                   Intermission screen  → [Space]
                              ↓
                       Game 2  (5 min)
                              ↓
                          Done screen
```

---

## Signal input

Any LSL stream that pushes normalized `[0, 1]` floats is supported. The bridge auto-discovers streams — select one in the **resp stream** selector before pressing Start.

For testing without real hardware:

```bash
# Synthetic sine-wave breath
cd resp && python simulate_lsl.py --bpm 14

# Mouse Y as breath (top = exhale, bottom = inhale)
cd resp && python mouse_y_to_lsl.py
```

---

## Data output

Saved to `bioGameData/<SUBJECT_CODE>/` (or your chosen data dir).

### Frame data — `block_<N>_frames.csv`

One row every 50 ms during a game.

| Column | Description |
|---|---|
| `timestamp` | ISO-8601 wall-clock time |
| `blockIndex` | 0 = Game 1, 1 = Game 2 |
| `breathRaw` | Raw LSL sample |
| `breathSmoothed` | Gaussian-smoothed sample |
| `breathNorm` | Normalized to calibration range `[0, 1]` |
| `fishY` | Fish vertical position `[0 = bottom, 1 = top]` |
| `targetY` | Target curve value at this moment |
| `starfishCount` | Starfish currently on screen (uncollected) |

### Events — `block_<N>_events.csv`

| Column | Description |
|---|---|
| `timestamp` | ISO-8601 wall-clock time |
| `blockIndex` | 0 / 1 |
| `event` | `star_collect`, `star_miss`, `block_end`, `block_abort` |
| `value1` | Score at collect / miss — otherwise empty |
| `value2` | Block time in seconds at the event |

---

## LSL markers

Sent to the WebSocket marker bridge (`ws://localhost:8765` by default). Enable/disable in `bioGame_config.js`:

```js
SEND_MARKERS:      true,
MARKER_STREAM_URL: 'ws://localhost:8765',
```

| Marker | Event |
|---|---|
| `calibration_start` / `calibration_end` | calibration phase |
| `countdown_start_block0` / `countdown_start_block1` | countdown before each game |
| `block_start_0` / `block_start_1` | game begins |
| `block_end_0` / `block_end_1` | game ends normally |
| `block_abort_0` / `block_abort_1` | game aborted |
| `star_collect_b<N>_s<score>` | starfish collected |
| `star_miss_b<N>` | starfish missed |
| `experiment_done` | both games complete |
