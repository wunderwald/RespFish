# calibration — Respiration Signal Calibration

One module:

| Module | Purpose |
|---|---|
| [calibration.js](../modules/calibration/calibration.js) | Records the breath signal for a fixed duration, returns the scaling range |

---

## calibration.js

### RespCalibration

Records samples for a fixed duration, then derives a `[min, max]` range (scaled
by `gain`) used to normalize live incoming signal values. Used by
[bioGame](bioGame.md) and [iBreath](ibreath.md) to turn a raw calibration
recording into a scaling range for the rest of the session.

```js
import { RespCalibration } from './modules/calibration/calibration.js';

const cal = new RespCalibration({ durationSecs: 10, gain: 0.8 });  // gain defaults to 0.8
cal.start();

// push a sample each time one arrives during the calibration phase
cal.push(sample);

// each tick / frame:
if (cal.isDone) {
  const result = cal.finish();   // { min, max, sampleCount } | null
  if (!result) {
    // no samples recorded (e.g. stream hiccup) — caller decides what to do next
  } else {
    const [min, max] = [result.min, result.max];
  }
}

cal.progress;       // 0..1, elapsed fraction of durationSecs
cal.remainingSecs;   // seconds left
```

`RespCalibration` itself has no opinion on what to do when `finish()` returns
`null` — that choice (retry vs. fall back to a default range) is up to the
caller. [bioGame](bioGame.md) and [iBreath](ibreath.md) both surface it to the
experimenter as a **Retry calibration** / **Use default calibration** choice
in the HUD, falling back to each frontend's `CONFIG.DEFAULT_CAL_RANGE` when
"use default" is chosen.

`gain` narrows (or widens) the calibrated range around its recorded values —
narrowing (the default, `0.8`) increases sensitivity over the calibrated
range, useful since participants often breathe more shallowly during a short
calibration than during the task itself.

`RespCalibration` only records samples and computes the range — it does not
smooth the signal (use [`GaussianSmoother`](signal.md) beforehand if needed)
or apply the scaling itself (use [`mapRange`](signal.md) with the returned
`[min, max]`).
