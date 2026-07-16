/**
 * calibration.js — Respiration signal calibration
 * =================================================
 * Records the breath signal for a fixed duration, then returns the
 * min/max range used to scale live incoming samples to a normalized range.
 *
 * Usage:
 *   const cal = new RespCalibration({ durationSecs: 10 });
 *   cal.start();
 *   cal.push(sample);            // call for each sample during calibration
 *   if (cal.isDone) {
 *     const result = cal.finish();   // { min, max, sampleCount } | null
 *   }
 */
export class RespCalibration {
  #durationSecs;
  #gain;
  #samples = [];
  #startTime = null;

  /**
   * @param {object} opts
   * @param {number} opts.durationSecs  How long to record before finish() is meaningful
   * @param {number} [opts.gain]        Factor applied to min/max on finish() (default 0.8)
   */
  constructor({ durationSecs, gain = 0.8 } = {}) {
    this.#durationSecs = durationSecs;
    this.#gain = gain;
  }

  /** Begin (or restart) recording. */
  start() {
    this.#samples = [];
    this.#startTime = performance.now();
  }

  /** Record one sample. Caller decides whether to push raw or smoothed values. */
  push(value) {
    this.#samples.push(value);
  }

  get elapsedSecs() {
    return this.#startTime != null ? (performance.now() - this.#startTime) / 1000 : 0;
  }

  get remainingSecs() {
    return Math.max(0, this.#durationSecs - this.elapsedSecs);
  }

  /** Elapsed fraction of durationSecs, clamped to [0, 1]. */
  get progress() {
    return Math.min(1, Math.max(0, this.elapsedSecs / this.#durationSecs));
  }

  get isDone() {
    return this.elapsedSecs >= this.#durationSecs;
  }

  get sampleCount() {
    return this.#samples.length;
  }

  /**
   * Computes the scaling range from recorded samples.
   * @returns {{min: number, max: number, sampleCount: number} | null}
   *   null if no samples were recorded — caller should retry (call start() again).
   */
  finish() {
    if (this.#samples.length === 0) return null;
    return {
      min: Math.min(...this.#samples) * this.#gain,
      max: Math.max(...this.#samples) * this.#gain,
      sampleCount: this.#samples.length,
    };
  }
}
