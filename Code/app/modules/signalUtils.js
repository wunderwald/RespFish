/**
 * signalUtils.js — Signal processing utilities
 * =============================================
 * Pure, framework-free utilities used by ibreath.js (and any future frontend).
 *
 * Exports:
 *   class  GaussianSmoother        — real-time Gaussian low-pass filter
 *   class  FrequencyEstimator      — swappable breath frequency/amp/phase estimator
 *   class  AutocorrEstimator       — autocorrelation-based estimator (default impl)
 *   class  AsyncSignalGenerator    — sine + Perlin noise async stimulus
 *   function mapRange(v, from, to) — linear range mapping
 *   function perlin1d(len)         — 1-D Perlin-ish noise array
 */


// ── mapRange ─────────────────────────────────────────────────────────────────
// Direct port of mapRange.m

/**
 * Maps value from one range to another.
 * @param {number} value
 * @param {[number,number]} from  [min, max] of input range
 * @param {[number,number]} to    [min, max] of output range
 * @returns {number}
 */
export function mapRange(value, from, to) {
  const factor = (value - from[0]) / (from[1] - from[0]);
  return to[0] + factor * (to[1] - to[0]);
}



// ── perlin1d ──────────────────────────────────────────────────────────────────
// Port of perlin1d.m / perlin2d.m — produces a smooth noise array in [0, 1].
// Not true Perlin noise but a smooth interpolated random signal matching the
// statistical character of the MATLAB implementation.

/**
 * Generates a 1-D smooth noise array of the given length, values in [0, 1].
 * @param {number} len
 * @returns {Float32Array}
 */
export function perlin1d(len) {
  // Build layered octave noise, same approach as the MATLAB perlin2d.m
  const out = new Float32Array(len);
  let w = len;
  let octave = 1;

  while (w > 3) {
    // Random control points spaced by current octave width
    const numPoints = Math.ceil(len / w) + 2;
    const ctrl = new Float32Array(numPoints).map(() => Math.random());

    // Cubic interpolation between control points
    for (let i = 0; i < len; i++) {
      const pos = (i / len) * (numPoints - 1);
      const idx = Math.floor(pos);
      const t   = pos - idx;
      const t2  = t * t;
      const t3  = t2 * t;

      const p0 = ctrl[Math.max(idx - 1, 0)];
      const p1 = ctrl[idx];
      const p2 = ctrl[Math.min(idx + 1, numPoints - 1)];
      const p3 = ctrl[Math.min(idx + 2, numPoints - 1)];

      // Catmull-Rom spline
      const v = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
      out[i] += octave * v;
    }

    w = w - Math.ceil(w / 2 - 1);
    octave++;
  }

  // Normalise to [0, 1]
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < len; i++) {
    if (out[i] < min) min = out[i];
    if (out[i] > max) max = out[i];
  }
  const range = max - min || 1;
  for (let i = 0; i < len; i++) out[i] = (out[i] - min) / range;

  return out;
}


// ── GaussianSmoother ─────────────────────────────────────────────────────────

/**
 * Real-time Gaussian low-pass filter over a sliding window.
 * Matches the behaviour of applyGaussianLPF.m + smoothBreathRT.m.
 *
 * Usage:
 *   const smoother = new GaussianSmoother(64);
 *   smoother.push(rawSample);
 *   const smoothed = smoother.value;  // current smoothed output
 */
export class GaussianSmoother {
  #windowSize;
  #kernel;      // normalised Gaussian kernel (Float32Array)
  #ring;        // circular buffer of raw samples
  #head = 0;    // next write position
  #count = 0;   // samples pushed so far (saturates at windowSize)

  /**
   * @param {number} windowSize  Number of samples in the smoothing window (default 64)
   */
  constructor(windowSize = 64) {
    this.#windowSize = windowSize;
    this.#kernel = GaussianSmoother.#makeKernel(windowSize);
    this.#ring   = new Float32Array(windowSize);
  }

  /** Push a new raw sample into the smoother. */
  push(sample) {
    this.#ring[this.#head] = sample;
    this.#head = (this.#head + 1) % this.#windowSize;
    if (this.#count < this.#windowSize) this.#count++;
  }

  /**
   * Current smoothed value (weighted average of the buffer).
   * Returns the raw last sample if fewer than 2 samples have been pushed.
   */
  get value() {
    if (this.#count < 2) {
      // Return the most recent sample raw
      const last = (this.#head - 1 + this.#windowSize) % this.#windowSize;
      return this.#ring[last];
    }

    const n = this.#count;  // actual filled length (≤ windowSize)

    // Build a kernel trimmed to n samples and re-normalised
    let sum = 0;
    const weights = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Take from the end of the full kernel so the shape stays consistent
      weights[i] = this.#kernel[this.#windowSize - n + i];
      sum += weights[i];
    }

    let out = 0;
    for (let i = 0; i < n; i++) {
      // oldest sample first: ring index offset from current head
      const ringIdx = (this.#head - n + i + this.#windowSize * 2) % this.#windowSize;
      out += this.#ring[ringIdx] * (weights[i] / sum);
    }
    return out;
  }

  /** Discard all buffered samples (e.g. between trials). */
  reset() {
    this.#ring.fill(0);
    this.#head  = 0;
    this.#count = 0;
  }

  // Build a normalised Gaussian kernel (σ = windowSize / 6)
  static #makeKernel(size) {
    const kernel = new Float32Array(size);
    const sigma  = size / 6;
    const center = (size - 1) / 2;
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const x = i - center;
      kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
      sum += kernel[i];
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;
    return kernel;
  }
}


// ── FrequencyEstimator (abstract interface) ───────────────────────────────────

/**
 * Base class / interface for breath frequency estimators.
 * Swap implementations by passing a different subclass to AsyncSignalGenerator.
 *
 * Subclasses must implement:
 *   estimate(signal: Float32Array, sampleRate: number)
 *     → { freq: number, amp: number, phase: number }
 *
 *   freq  — angular frequency in rad/s  (= 2π / period_seconds)
 *   amp   — peak-to-peak amplitude of the signal (same units as signal)
 *   phase — phase offset in radians, such that sin(freq·t − phase) ≈ signal
 */
export class FrequencyEstimator {
  /**
   * @param {Float32Array} signal      Calibration signal samples
   * @param {number}       sampleRate  Samples per second
   * @returns {{ freq: number, amp: number, phase: number }}
   */
  // eslint-disable-next-line no-unused-vars
  estimate(_signal, _sampleRate) {
    throw new Error("FrequencyEstimator.estimate() must be implemented by subclass");
  }
}


// ── AutocorrEstimator ─────────────────────────────────────────────────────────

/**
 * Autocorrelation-based frequency estimator.
 *
 * Algorithm:
 *   1. Remove DC offset (subtract mean).
 *   2. Compute normalised autocorrelation.
 *   3. Find the first prominent peak after lag 0 — that lag is the period.
 *   4. Amplitude = (max − min) / 2 of the original signal.
 *   5. Phase: find the first zero-crossing from below (inhale onset) and
 *      compute its time offset → phase offset for the sine fit.
 *
 * Advantages over the MATLAB peak-detection approach:
 *   - Does not depend on a threshold parameter.
 *   - Works with asymmetric breath cycles (inhale ≠ exhale duration).
 *   - Robust to amplitude variations across breaths.
 *   - Degrades gracefully: falls back to sensible defaults if estimation fails.
 */
export class AutocorrEstimator extends FrequencyEstimator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minBreathPeriod=2]   Minimum plausible breath period (s)
   * @param {number} [opts.maxBreathPeriod=12]  Maximum plausible breath period (s)
   */
  constructor({ minBreathPeriod = 2, maxBreathPeriod = 12 } = {}) {
    super();
    this.minBreathPeriod = minBreathPeriod;
    this.maxBreathPeriod = maxBreathPeriod;
  }

  estimate(signal, sampleRate) {
    const n = signal.length;

    // ── 1. Remove DC offset ───────────────────────────────────────────────
    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;
    const centered = new Float32Array(n);
    for (let i = 0; i < n; i++) centered[i] = signal[i] - mean;

    // ── 2. Normalised autocorrelation ─────────────────────────────────────
    // r[lag] = Σ centered[i] · centered[i + lag]  /  r[0]
    const maxLag = Math.min(n - 1, Math.floor(this.maxBreathPeriod * sampleRate));
    const minLag = Math.max(1,     Math.floor(this.minBreathPeriod * sampleRate));

    const acorr = new Float32Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += centered[i] * centered[i + lag];
      }
      acorr[lag] = sum;
    }
    const r0 = acorr[0] || 1;
    for (let lag = 0; lag <= maxLag; lag++) acorr[lag] /= r0;

    // ── 3. Find first prominent peak in acorr after minLag ────────────────
    let bestLag  = -1;
    let bestVal  = -Infinity;

    for (let lag = minLag; lag < maxLag - 1; lag++) {
      const isPeak = acorr[lag] > acorr[lag - 1] && acorr[lag] > acorr[lag + 1];
      if (isPeak && acorr[lag] > bestVal) {
        bestVal = acorr[lag];
        bestLag = lag;
        break;  // first prominent peak wins
      }
    }

    // Fallback: use a typical adult breathing period of 4 s
    const DEFAULT_PERIOD = 4;
    const periodSamples = bestLag > 0 ? bestLag : DEFAULT_PERIOD * sampleRate;
    const periodSeconds = periodSamples / sampleRate;
    const freq = (2 * Math.PI) / periodSeconds;

    // ── 4. Amplitude ──────────────────────────────────────────────────────
    let sigMin = Infinity, sigMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (signal[i] < sigMin) sigMin = signal[i];
      if (signal[i] > sigMax) sigMax = signal[i];
    }
    const amp = sigMax - sigMin > 0 ? sigMax - sigMin : 0.5;

    // ── 5. Phase ──────────────────────────────────────────────────────────
    // Find the first sample where the signal crosses amp/2 from below
    // (the rising edge ≈ start of exhale).
    const half = sigMin + amp / 2;
    let phase = 0;
    for (let i = 0; i < n - 1; i++) {
      if (signal[i] < half && signal[i + 1] >= half) {
        phase = (i / sampleRate) * freq;  // time offset converted to radians
        break;
      }
    }

    return { freq, amp, phase };
  }
}


// ── AsyncSignalGenerator ──────────────────────────────────────────────────────

/**
 * Generates the async (non-synchronous) stimulus signal:
 *   sine wave fitted to the participant's breath + blended Perlin noise.
 *
 * Matches the MATLAB asyncSignal.m behaviour while adding noise blending.
 *
 * Usage:
 *   const gen = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });
 *   gen.calibrate(signalArray, sampleRate);      // call after calibration phase
 *   gen.setSpeedFactor(1.1);                     // slow (>1) or fast (<1)
 *   const level = gen.sample(tSeconds);          // call each frame
 */
export class AsyncSignalGenerator {
  // Noise configuration 
  static NOISE_LENGTH   = 150;
  static NOISE_BLEND    = 0.02;   // 2% noise, 98% sine (ADD_NOISE_ASYNC)

  #estimator;
  #freq        = (2 * Math.PI) / 4;  // default: 4 s period
  #amp         = 0.5;
  #phase       = 0;
  #speedFactor = 1.0;
  #noise       = null;   // Float32Array, ping-pong loop
  #noiseIndex  = 0;
  #noisePeak   = 1;
  #calibrated  = false;

  // Range of the sync stimulus, used for MAP_ASYNC_RANGE_TO_SYNC_RANGE
  #syncRange   = null;   // [min, max] | null

  /**
   * @param {object} opts
   * @param {FrequencyEstimator} [opts.estimator]  Defaults to AutocorrEstimator
   */
  constructor({ estimator } = {}) {
    this.#estimator = estimator ?? new AutocorrEstimator();
    this.#buildNoise();
  }

  /**
   * Run the estimator on a calibration signal and store results.
   * @param {Float32Array|number[]} signal      Calibration samples
   * @param {number}                sampleRate  Samples per second
   * @param {[number,number]|null}  syncRange   [min, max] of sync stimulus
   *                                            (pass null to skip range mapping)
   */
  calibrate(signal, sampleRate, syncRange = null) {
    const arr = signal instanceof Float32Array ? signal : new Float32Array(signal);
    const { freq, amp, phase } = this.#estimator.estimate(arr, sampleRate);

    this.#freq      = isFinite(freq)  && freq  > 0 ? freq  : (2 * Math.PI) / 4;
    this.#amp       = isFinite(amp)   && amp   > 0 ? amp   : 0.5;
    this.#phase     = isFinite(phase)             ? phase : 0;
    this.#syncRange = syncRange;
    this.#calibrated = true;
    this.#buildNoise();

    console.log(
      `[AsyncSignalGenerator] calibrated — ` +
      `period=${(2 * Math.PI / this.#freq).toFixed(2)}s  ` +
      `amp=${this.#amp.toFixed(3)}  phase=${this.#phase.toFixed(3)}`
    );
  }

  /**
   * Speed factor applied to the async sine frequency.
   * > 1 → slower than breath,  < 1 → faster than breath.
   * Matches the MATLAB slowfast logic: factor = 1.1 (slow) or 0.9 (fast).
   * @param {number} factor
   */
  setSpeedFactor(factor) {
    this.#speedFactor = factor;
  }

  /**
   * Returns the stimulus level for time t (seconds since trial start).
   * Output is in [0, 1] (approximately — Perlin noise can push it slightly).
   * @param {number} t  Seconds since trial start
   * @returns {number}
   */
  sample(t) {
    // asyncSignal.m: amp/2 * sin(freq * t / factor − phase) + amp/2
    const sine = (this.#amp / 2) *
      Math.sin((this.#freq * t) / this.#speedFactor - this.#phase) +
      (this.#amp / 2);

    // Add Perlin noise (ping-pong loop)
    const noiseSample = this.#noise[this.#noiseIndex % this.#noise.length];
    this.#noiseIndex++;
    const noiseNorm = noiseSample / this.#noisePeak;

    const blended = (1 - AsyncSignalGenerator.NOISE_BLEND) * sine +
                    AsyncSignalGenerator.NOISE_BLEND * noiseNorm;

    // Map to sync range if provided
    if (this.#syncRange) {
      return mapRange(blended, [0, this.#amp], this.#syncRange);
    }
    return blended;
  }

  /** Whether calibrate() has been called successfully. */
  get isCalibrated() { return this.#calibrated; }

  /** Current estimated period in seconds (useful for display / debugging). */
  get periodSeconds() { return (2 * Math.PI) / this.#freq; }

  // Build ping-pong Perlin noise array
  #buildNoise() {
    const len = AsyncSignalGenerator.NOISE_LENGTH;
    const forward  = perlin1d(len);
    const backward = new Float32Array(len);
    for (let i = 0; i < len; i++) backward[i] = forward[len - 1 - i];

    this.#noise = new Float32Array(len * 2);
    this.#noise.set(forward,  0);
    this.#noise.set(backward, len);

    this.#noisePeak = 0;
    for (let i = 0; i < this.#noise.length; i++) {
      if (this.#noise[i] > this.#noisePeak) this.#noisePeak = this.#noise[i];
    }
    this.#noiseIndex = 0;
  }
}
