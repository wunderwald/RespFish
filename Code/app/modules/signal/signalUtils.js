/**
 * signalUtils.js — Real-time signal processing utilities
 * =======================================================
 * Exports:
 *   class    GaussianSmoother     — real-time Gaussian low-pass filter
 *   class    AsyncSignalGenerator — sine + Perlin noise async stimulus
 *   function mapRange(v, from, to)
 *   function perlin1d(len)
 *
 * All frequency/rate estimators live in breathRateEstimators.js.
 */

import { AutocorrEstimator } from './breathRateEstimators.js';


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
  const span = from[1] - from[0];
  if (span === 0) return (to[0] + to[1]) / 2;
  return to[0] + ((value - from[0]) / span) * (to[1] - to[0]);
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
      const t = pos - idx;
      const t2 = t * t;
      const t3 = t2 * t;

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
    this.#ring = new Float32Array(windowSize);
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
    this.#head = 0;
    this.#count = 0;
  }

  // Build a normalised Gaussian kernel (σ = windowSize / 6)
  static #makeKernel(size) {
    const kernel = new Float32Array(size);
    const sigma = size / 6;
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
  static NOISE_LENGTH = 150;
  static NOISE_BLEND = 0.02;   // 2% noise, 98% sine (ADD_NOISE_ASYNC)

  #estimator;
  #freq = (2 * Math.PI) / 4;  // default: 4 s period
  #amp = 0.5;
  #speedFactor = 1.0;
  #noise = null;   // Float32Array, ping-pong loop
  #noiseIndex = 0;
  #noisePeak = 1;
  #calibrated = false;

  // Range of the sync stimulus, used for MAP_ASYNC_RANGE_TO_SYNC_RANGE
  #syncRange = null;   // [min, max] | null

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
   * @param {[number,number]|null}  syncRange   Output range for sample(), in the same [0,1]
   *                                            display space the caller renders/sonifies —
   *                                            NOT the raw signal's native scale
   *                                            (pass null to use the sine's natural [0, amp] range)
   */
  calibrate(signal, sampleRate, syncRange = null) {
    const arr = signal instanceof Float32Array ? signal : new Float32Array(signal);
    const { freq, amp } = this.#estimator.estimate(arr, sampleRate);

    this.#freq = isFinite(freq) && freq > 0 ? freq : (2 * Math.PI) / 4;
    this.#amp = isFinite(amp) && amp > 0 ? amp : 0.5;
    this.#syncRange = syncRange;
    this.#calibrated = true;
    this.#buildNoise();

    console.log(
      `[AsyncSignalGenerator] calibrated — ` +
      `period=${(2 * Math.PI / this.#freq).toFixed(2)}s  ` +
      `amp=${this.#amp.toFixed(3)}`
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
    // asyncSignal.m: amp/2 * sin(freq * t / factor) + amp/2
    const sine = (this.#amp / 2) *
      Math.sin((this.#freq * t) / this.#speedFactor) +
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
    const forward = perlin1d(len);
    const backward = new Float32Array(len);
    for (let i = 0; i < len; i++) backward[i] = forward[len - 1 - i];

    this.#noise = new Float32Array(len * 2);
    this.#noise.set(forward, 0);
    this.#noise.set(backward, len);

    this.#noisePeak = 0;
    for (let i = 0; i < this.#noise.length; i++) {
      if (this.#noise[i] > this.#noisePeak) this.#noisePeak = this.#noise[i];
    }
    this.#noiseIndex = 0;
  }
}
