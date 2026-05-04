# Game design notes

## Breathing phase logic

The game uses **asymmetric phase timing**:

- **Inhale phase** — no fixed duration. The game waits indefinitely for the next exhale onset. This means the child can take as long as they need to breathe in.
- **Exhale phase** — fixed duration of `beatMs / 2` (2.5 s at the default 12 BPM target). Starts the moment an exhale onset is detected, ends on the clock regardless of what the signal does.

This design means the game adapts to the child's natural inhale pace while still training a consistent, sustained exhale.

## Exhale detection

An exhale onset is detected by a **rising edge**: the normalised signal crosses `EXHALE_ONSET_THRESHOLD` (0.20) from below. The signal is normalised to [0, 1] using the min/max range recorded during calibration.

A **debounce** of 1500 ms prevents a single noisy breath from triggering multiple rounds.

## Success criterion

During the exhale phase, the game accumulates the time the signal spends **above threshold** (`exhaleTimeAbove`). At the end of the phase:

```
ratio = exhaleTimeAbove / (beatMs / 2)
success = ratio >= EXHALE_SUCCESS_RATIO (0.90)
```

The child must sustain exhalation for at least 90 % of the 2.5 s window. Short puffs that drop back below threshold mid-exhale will fail.

## Cloud timing

Clouds spawn at the **start of the inhale phase** (i.e. immediately after the previous exhale ends) and drift slowly toward the sun over `CLOUD_SLIDE_MS` (2200 ms). This means the cloud is already near the sun by the time the next exhale begins, giving the child a clear visual cue of what is coming rather than a cloud that only appears after they start blowing.

A first cloud is also spawned immediately when the game starts.

## Failed clouds

If a round fails, the cloud slides to an orbit position around the sun and fades out slowly over 60 s (`FAIL_FADE_MS`). Up to 12 orbit positions are used (evenly distributed), cycling if more clouds accumulate.

## Signal normalisation

The incoming signal is assumed to already be normalised to [0, 1] by the stream layer. No in-game calibration is performed.

## Countdown

When the player presses Start, a 3-second countdown (3 → 2 → 1 → GO!) plays before the game begins. Each digit pulses in with a brief scale animation. The game starts immediately after "GO!" (3.5 s total).

## Debug overlay

During play a single line at the bottom of the screen shows:
- Current **game phase** (BREATHE IN / BREATHE OUT)
- Current **normalised signal level** (0.00 – 1.00)
- Whether the signal is currently counted as **inhaling or exhaling** (above/below threshold)
