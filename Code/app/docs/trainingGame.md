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

### Breathing phase logic

The game uses **asymmetric phase timing**:

- **Inhale phase** — no fixed duration. The game waits indefinitely for the next exhale onset.
- **Exhale phase** — fixed duration of `beatMs / 2` (5 s at the default 6 BPM target). Starts the moment an exhale onset is detected, ends on the clock.

This design adapts to the child's natural inhale pace while training a consistent, sustained exhale.

### Exhale detection

An exhale onset is detected by a **rising edge**: the normalised signal crosses `EXHALE_ONSET_THRESHOLD` (0.40) from below.

A **debounce** of 1500 ms prevents a single noisy breath from triggering multiple rounds.

### Success criterion

During the exhale phase the game accumulates the time the signal spends above threshold (`exhaleTimeAbove`). At the end of the phase:

```
ratio = exhaleTimeAbove / (beatMs / 2)
success = ratio >= EXHALE_SUCCESS_RATIO (0.90)
```

The child must sustain exhalation for at least 90 % of the window. Short puffs that drop back below threshold mid-exhale will fail.

### Cloud timing

Clouds spawn at the **start of the inhale phase** and drift toward the sun over `CLOUD_SLIDE_MS` (2200 ms). The cloud is already near the sun by the time the next exhale begins, giving a clear visual cue of what is coming.

A first cloud is spawned immediately when the game starts.

### Failed clouds

If a round fails, the cloud slides to an orbit position around the sun and fades out slowly over 60 s. Up to 12 orbit positions are used (evenly distributed), cycling if more clouds accumulate.

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
| `CLOUD_SLIDE_MS` | `2200` | Time for a cloud to travel to the sun (ms) |
| `FAIL_FADE_MS` | `60000` | Time for a failed cloud to fade out (ms) |

---

## Signal input

Any LSL stream pushing normalised `[0, 1]` floats. The signal is assumed to already be normalised — no in-game calibration is performed.


For testing, use the microphone streamer as resp input:

```bash
cd resp && python mic_breath.py              # microphone
```
