# signal — Signal Processing Utilities

Utilitiy functions in [app/modules/signal/signalUtils.js](./modules/signal/signalUtils.js).

---

## GaussianSmoother

Real-time Gaussian low-pass filter over a sliding window. Matches `applyGaussianLPF.m` + `smoothBreathRT.m` (from old MATLAB iBreath project).

```js
import { GaussianSmoother } from './modules/signal/signalUtils.js';

const smoother = new GaussianSmoother(64);  // window size in samples
smoother.push(rawSample);
const smoothed = smoother.value;  // current weighted output
smoother.reset();                 // clear buffer between trials
```

The kernel is a normalised Gaussian with σ = `windowSize / 6`. The buffer fills incrementally — the first few samples use a trimmed, re-normalised kernel so there is no step at startup.

---

## AutocorrEstimator

Autocorrelation-based breath frequency estimator. Used by `AsyncSignalGenerator` to fit a sine wave to the participant's calibration signal.

```js
import { AutocorrEstimator } from './modules/signal/signalUtils.js';

const est = new AutocorrEstimator({ minBreathPeriod: 2, maxBreathPeriod: 12 });
const { freq, amp, phase } = est.estimate(signalArray, sampleRate);
// freq  — angular frequency in rad/s
// amp   — peak-to-peak amplitude
// phase — phase offset in radians
```

Falls back to a 4-second period if no autocorrelation peak is found within the plausible range. *THIS NEEDS TO CHANGE!*

---

## AsyncSignalGenerator

Generates the asynchronous stimulus signal: a sine wave fitted to the participant's breath, with a small Perlin noise blend (2 %) and an optional speed shift.

```js
import { AsyncSignalGenerator, AutocorrEstimator } from './modules/signal/signalUtils.js';

const gen = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });

// After calibration phase
gen.calibrate(signalArray, sampleRate, syncRange);  // syncRange = [min, max] or null

// Set speed relative to participant's breath period
gen.setSpeedFactor(1.1);  // > 1 = slower,  < 1 = faster

// Sample during trial
const level = gen.sample(tSeconds);  // returns ~[0, 1]
```

`calibrate()` fits the estimator and optionally maps output to `syncRange` so async and sync stimuli share the same visual amplitude.

---

## mapRange

Linear interpolation between two ranges. Direct port of `mapRange.m`.

```js
import { mapRange } from './modules/signal/signalUtils.js';

const out = mapRange(value, [inMin, inMax], [outMin, outMax]);
```

Returns the midpoint of the output range when the input range has zero span.

---

## perlin1d

Generates a smooth 1-D noise array of length `len`, values in `[0, 1]`. Uses layered octave noise with Catmull-Rom interpolation, matching the statistical character of the MATLAB `perlin2d.m` implementation.

```js
import { perlin1d } from './modules/signal/signalUtils.js';

const noise = perlin1d(150);  // Float32Array
```

Used internally by `AsyncSignalGenerator` to build a ping-pong noise loop.

---

## FrequencyEstimator

Abstract base class for frequency estimators. Subclass and implement `estimate(signal, sampleRate)` to swap in a different algorithm.

```js
import { FrequencyEstimator } from './modules/signal/signalUtils.js';

class MyEstimator extends FrequencyEstimator {
  estimate(signal, sampleRate) {
    // return { freq, amp, phase }
  }
}

const gen = new AsyncSignalGenerator({ estimator: new MyEstimator() });
```
