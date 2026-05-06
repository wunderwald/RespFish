# trainingGame — Exhale Training Game

A breath-controlled game. The player blows away clouds by exhaling steadily, trying to keep the sun happy. Each exhale that lasts long enough dissolves a cloud and scores a point, keeping the sky from becoming dark.

---

## Run

```bash
cd app && npm run trainingGame
```

Two windows open:
- **Scene window** — shown on the participant's screen (fullscreen sun and clouds)
- **Experimenter window** — your control panel

---

## Experimenter controls

| Control | What it does |
|---|---|
| **Stream selector** | Choose the resp LSL stream. Required before pressing Start. |
| **Start** | Begins the 3-second countdown then the game. |
| **Score** | Live count of clouds successfully blown away. |

**Keyboard shortcuts:**
- `Space` — start the game (same as clicking Start)

---

## How it works

### Breathing phases (symmetric, both 5 s at default 6 BPM)

`beatMs = (60 / TARGET_BPM) * 1000 = 10 000 ms`. Each phase lasts `beatMs / 2 = 5 s`.

- **Inhale phase** — up to 5 s. If no exhale onset is detected before the window expires, the active cloud auto-fails and the next round starts.
- **Exhale phase** — exactly 5 s. Starts the moment an exhale onset is detected, ends on the clock.

### Exhale detection

An exhale onset is detected by a **rising edge**: the normalised signal crosses `EXHALE_ONSET_THRESHOLD` (0.40) from below.

A **debounce** of 1500 ms prevents multiple triggers from a single noisy crossing.

### Success criterion

During the exhale phase the game accumulates the time the signal spends above threshold (`exhaleTimeAbove`). At the end of the phase:

```
ratio = exhaleTimeAbove / (beatMs / 2)
success = ratio >= EXHALE_SUCCESS_RATIO (0.90)
```

The player must sustain exhalation for at least 90 % of the 5 s window.

### Cloud timing

When the inhale phase starts, a cloud spawns from a random screen edge `CLOUD_SPAWN_DELAY_MS` (2.5 s) later and slides toward the sun over `CLOUD_SLIDE_IN_MS` (2 s). The first cloud spawns immediately when the game starts.

### Failed clouds

If a round fails, the cloud slides to an orbit position around the sun over `CLOUD_SLIDE_MS` (2.2 s), then slowly fades over `FAIL_FADE_MS` (60 s). Up to 12 orbit positions are used, cycling if more clouds accumulate.

---

## Configuration

In [app/modules/trainingGame/trainingGame_config.js](./modules/trainingGame/trainingGame_config.js):

| Parameter | Default | Description |
|---|---|---|
| `TARGET_BPM` | `6` | Target breath rate — sets the exhale phase duration |
| `GAME_DURATION_SECS` | `60` | Total game length in seconds |
| `EXHALE_ONSET_THRESHOLD` | `0.40` | Signal level to detect start of exhale |
| `BREATH_DEBOUNCE_MS` | `1500` | Minimum ms between exhale detections |
| `EXHALE_SUCCESS_RATIO` | `0.90` | Fraction of exhale window that must be above threshold |
| `CLOUD_SLIDE_IN_MS` | `2000` | Cloud slide-in from screen edge on spawn (ms) |
| `CLOUD_SPAWN_DELAY_MS` | `2500` | Delay from inhale start to cloud spawn (ms) |
| `CLOUD_SLIDE_MS` | `2200` | Slide duration for a failed cloud to its orbit position (ms) |
| `FAIL_FADE_MS` | `60000` | Time for a failed cloud to fade out (ms) |

---

## Signal input

Any LSL stream pushing normalised `[0, 1]` floats. The signal is assumed to already be normalised — no in-game calibration is performed.


For testing, use the microphone streamer as resp input:

```bash
cd resp && python mic_breath.py              # microphone
```
