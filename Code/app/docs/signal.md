# signal — Signal Processing Utilities

Two modules:

| Module | Purpose |
|---|---|
| [signalUtils.js](../modules/signal/signalUtils.js) | Real-time utilities: smoothing, sine synthesis, noise |
| [breathRateEstimators.js](../modules/signal/breathRateEstimators.js) | Offline breath rate estimation from recordings |

---

## signalUtils.js

### GaussianSmoother

Real-time Gaussian low-pass filter over a sliding window. Matches `applyGaussianLPF.m` + `smoothBreathRT.m`.

```js
import { GaussianSmoother } from './modules/signal/signalUtils.js';

const smoother = new GaussianSmoother(64);  // window size in samples
smoother.push(rawSample);
const smoothed = smoother.value;
smoother.reset();
```

---

### AsyncSignalGenerator

Generates the async stimulus signal: sine fitted to the participant's breath + 2 % Perlin noise blend.

```js
import { AsyncSignalGenerator } from './modules/signal/signalUtils.js';
import { AutocorrEstimator }    from './modules/signal/breathRateEstimators.js';

const gen = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });
gen.calibrate(signalArray, sampleRate, syncRange);  // syncRange = [min, max] in [0,1] display
                                                     // space (NOT raw signal units), or null
gen.setSpeedFactor(1.1);   // > 1 = slower,  < 1 = faster
const level = gen.sample(tSeconds);  // ~[0, 1]
```

---

### mapRange / perlin1d

```js
import { mapRange, perlin1d } from './modules/signal/signalUtils.js';

mapRange(value, [inMin, inMax], [outMin, outMax]);  // linear range mapping
perlin1d(150);  // Float32Array of smooth noise in [0, 1]
```

---

## breathRateEstimators.js

Contains all estimators. Two families:

### FrequencyEstimator / AutocorrEstimator / PeakDetectionEstimator

Sine-synthesis estimators used by `AsyncSignalGenerator`. Return `{ freq (rad/s), amp }`.

- **`AutocorrEstimator`** — autocorrelation peak; falls back to `PeakDetectionEstimator`, then a 4 s hard default.
- **`PeakDetectionEstimator`** — MATLAB-style inter-peak averaging; returns `null` on failure.
- **`FrequencyEstimator`** — abstract base; subclass to plug a custom algorithm into `AsyncSignalGenerator`.

```js
import { AutocorrEstimator, PeakDetectionEstimator, FrequencyEstimator }
  from './modules/signal/breathRateEstimators.js';

const { freq, amp } = new AutocorrEstimator({ minBreathPeriod: 2, maxBreathPeriod: 12 })
  .estimate(signalArray, sampleRate);
```

---

### Offline rate estimators

Return **Hz** (number) or `null` on failure.

### cleanSignal

Zero-phase first-order Butterworth bandpass filter (0.05–3 Hz default), following neurokit2's `rsp_clean()` approach. Applied with reflect edge padding to match scipy's `filtfilt` behaviour.

```js
import { cleanSignal } from './modules/signal/breathRateEstimators.js';

const cleaned = cleanSignal(signal, sampleRate);
// optional: cleanSignal(signal, sampleRate, { lowCut: 0.05, highCut: 3.0 })
```

All estimators apply this automatically when `clean: true` (default).

---

### AutocorrRateEstimator

Finds the first prominent positive peak in the normalised autocorrelation. Supports optional sliding window (50 % overlap).

```js
new AutocorrRateEstimator({ minPeriod: 2, maxPeriod: 12, clean: true, windowSecs: 30 })
  .estimate(signal, sampleRate)  // → Hz | null
```

---

### PeakTroughEstimator

Finds local minima below the signal mean (troughs), computes inter-trough intervals, filters to the physiological range, and averages. Based on neurokit2's `"trough"` method.

```js
new PeakTroughEstimator({ minPeriod: 2, maxPeriod: 12, clean: true })
  .estimate(signal, sampleRate)  // → Hz | null
```

---

### WelchEstimator

Divides the signal into overlapping (50 %) Hann-windowed segments, accumulates Goertzel power at each candidate frequency, and returns the peak in the physiological range. Returns `null` if the signal is shorter than `minSignalSecs` (default 20 s).

```js
new WelchEstimator({
  clean: true, windowSecs: null,
  minFreq: 0.05, maxFreq: 1.0, freqStep: 0.01,
  minSignalSecs: 20,
}).estimate(signal, sampleRate)  // → Hz | null
```

---

### XcorrEstimator

Cross-correlates the signal with template sinusoids at candidate frequencies (equivalent to evaluating the DFT at those frequencies) and returns the strongest match. Based on neurokit2's `'xcorr'` method.

```js
new XcorrEstimator({
  clean: true, windowSecs: null,
  minFreq: 0.05, maxFreq: 1.0, freqStep: 0.005,
}).estimate(signal, sampleRate)  // → Hz | null
```

---

### estimateBreathRate

Runs all four estimators and returns a dict. Each value is Hz | null.

```js
import { estimateBreathRate } from './modules/signal/breathRateEstimators.js';

const { autocorr, peakTrough, welch, xcorr } = estimateBreathRate(signal, sampleRate);

// Per-estimator options can be passed:
estimateBreathRate(signal, sampleRate, {
  welch: { windowSecs: 30 },
  xcorr: { freqStep: 0.01 },
});
```

---

### Sliding window

`AutocorrRateEstimator`, `WelchEstimator`, and `XcorrEstimator` support `windowSecs`. When set, the full signal is cleaned once, then split into overlapping 50 %-overlap windows of that length, each estimated independently. The returned value is the average of all non-null window results (null if none succeeded).

```js
const hz = new WelchEstimator({ windowSecs: 30 }).estimate(signal, sampleRate);
```
