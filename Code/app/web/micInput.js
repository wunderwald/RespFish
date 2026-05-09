import { GaussianSmoother } from '../modules/signal/signalUtils.js';

const FFT_SIZE           = 1024;
const SMOOTH_WINDOW      = 16;   // samples — light smoothing at 20 fps (~800 ms window)
const SAMPLE_INTERVAL_MS = 50;   // 20 fps

export class MicInput {
  #analyser   = null;
  #audioBuf   = null;
  #smoother   = new GaussianSmoother(SMOOTH_WINDOW);
  #floor      = 0;
  #range      = 1;
  #intervalId = null;

  /** Request microphone access and initialise the audio pipeline. */
  async init() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const actx   = new AudioContext();
    this.#analyser = actx.createAnalyser();
    this.#analyser.fftSize = FFT_SIZE;
    this.#audioBuf = new Float32Array(FFT_SIZE);
    actx.createMediaStreamSource(stream).connect(this.#analyser);
  }

  /**
   * Raw RMS of the current audio frame — used during calibration.
   * @returns {number}
   */
  getRaw() {
    if (!this.#analyser) return 0;
    this.#analyser.getFloatTimeDomainData(this.#audioBuf);
    let s = 0;
    for (const v of this.#audioBuf) s += v * v;
    return Math.sqrt(s / this.#audioBuf.length);
  }

  /**
   * Store the calibrated floor / ceil so start() can normalise to [0, 1].
   * @param {number} floor  Measured silence RMS
   * @param {number} ceil   Measured peak breath RMS
   */
  setCalibration(floor, ceil) {
    this.#floor = floor;
    this.#range = (ceil - floor) || 1;
    this.#smoother.reset();
  }

  /**
   * Begin sampling at 20 fps. Each tick: getRaw → smooth → normalise → onSample(norm).
   * @param {(norm: number) => void} onSample
   */
  start(onSample) {
    this.#intervalId = setInterval(() => {
      const raw  = this.getRaw();
      this.#smoother.push(raw);
      const norm = Math.max(0, Math.min(1, (this.#smoother.value - this.#floor) / this.#range));
      onSample(norm);
    }, SAMPLE_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.#intervalId);
    this.#intervalId = null;
  }
}
