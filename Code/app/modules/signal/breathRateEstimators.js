/**
 * breathRateEstimators.js — All breath frequency / rate estimators
 * ================================================================
 *
 * ── Sine-synthesis estimators (used by AsyncSignalGenerator) ────────────────
 * Return { freq (rad/s), amp }.
 *
 *   class  FrequencyEstimator      — abstract base class
 *   class  AutocorrEstimator       — autocorrelation + peak-detection fallback
 *   class  PeakDetectionEstimator  — MATLAB-style inter-peak averaging; null on failure
 *
 * ── Offline rate estimators ──────────────────────────────────────────────────
 * Return Hz | null.
 *
 *   function  cleanSignal(signal, sampleRate, opts)  — zero-phase bandpass filter
 *   class     AutocorrRateEstimator                  — autocorrelation peak method
 *   class     PeakTroughEstimator                    — trough-interval method (neurokit2 "trough")
 *   class     WelchEstimator                         — Welch PSD peak method
 *   class     XcorrEstimator                         — cross-correlation with template sinusoids
 *   function  estimateBreathRate(signal, sr, opts)   — run all rate methods, return dict
 */


// ── Internal helpers ──────────────────────────────────────────────────────────

function _toF64(signal) {
  return (signal instanceof Float64Array) ? signal : Float64Array.from(signal);
}

// First-order IIR: y[n] = b0*x[n] + b1*x[n-1] - a1*y[n-1]
function _iir1(signal, b0, b1, a1) {
  const n = signal.length;
  const out = new Float64Array(n);
  let yp = 0, xp = 0;
  for (let i = 0; i < n; i++) {
    const x = signal[i];
    out[i] = b0 * x + b1 * xp - a1 * yp;
    xp = x; yp = out[i];
  }
  return out;
}

// Zero-phase forward-backward IIR filtering (like scipy filtfilt)
function _filtfilt1(signal, b0, b1, a1) {
  const fwd = _iir1(signal, b0, b1, a1);
  const n = fwd.length;
  const rev = new Float64Array(n);
  for (let i = 0; i < n; i++) rev[i] = fwd[n - 1 - i];
  const bwd = _iir1(rev, b0, b1, a1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = bwd[n - 1 - i];
  return out;
}

// Reflect-pad signal to reduce edge transients in filtfilt
function _reflectPad(signal, padLen) {
  const n = signal.length;
  const p = Math.min(padLen, n - 1);
  if (p <= 0) return signal instanceof Float64Array ? signal : Float64Array.from(signal);
  const out = new Float64Array(n + 2 * p);
  for (let i = 0; i < p; i++) out[i] = signal[p - i];          // left reflection
  out.set(signal, p);
  for (let i = 0; i < p; i++) out[p + n + i] = signal[n - 2 - i]; // right reflection
  return out;
}

// Hann window applied to a copy of the segment
function _hann(segment) {
  const n = segment.length;
  const out = new Float64Array(n);
  const nm1 = n - 1 || 1;
  for (let i = 0; i < n; i++) {
    out[i] = segment[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / nm1));
  }
  return out;
}

// Goertzel DFT power at a specific frequency (exact, works for non-integer bins)
function _goertzelPower(segment, freqHz, sampleRate) {
  const omega = 2 * Math.PI * freqHz / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < segment.length; i++) {
    const s = segment[i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  // |DFT|² = s1² + s2² − 2·cos(ω)·s1·s2
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Extract overlapping windows (50% overlap) from a signal
function _slidingWindows(signal, sampleRate, windowSecs) {
  const winLen = Math.floor(windowSecs * sampleRate);
  const step   = Math.max(1, Math.floor(winLen * 0.5));
  const wins   = [];
  for (let start = 0; start + winLen <= signal.length; start += step) {
    wins.push(signal.slice(start, start + winLen));
  }
  return wins;
}

// Average of a number[] ignoring nulls; returns null if no valid values
function _meanNonNull(arr) {
  const valid = arr.filter(v => v !== null && isFinite(v));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}


// ── FrequencyEstimator (abstract interface) ───────────────────────────────────

/**
 * Base class for sine-synthesis frequency estimators used by AsyncSignalGenerator.
 * Subclasses implement: estimate(signal, sampleRate) → { freq (rad/s), amp }
 */
export class FrequencyEstimator {
  // eslint-disable-next-line no-unused-vars
  estimate(_signal, _sampleRate) {
    throw new Error('FrequencyEstimator.estimate() must be implemented by subclass');
  }
}


// ── AutocorrEstimator ─────────────────────────────────────────────────────────

/**
 * Autocorrelation-based frequency estimator for sine synthesis.
 * Returns { freq (rad/s), amp }.  Falls back to PeakDetectionEstimator when
 * no valid autocorrelation peak is found; falls back to a 4 s default if both
 * methods fail.
 *
 * @param {{ minBreathPeriod?, maxBreathPeriod? }} [opts]
 */
export class AutocorrEstimator extends FrequencyEstimator {
  constructor({ minBreathPeriod = 2, maxBreathPeriod = 12 } = {}) {
    super();
    this.minBreathPeriod = minBreathPeriod;
    this.maxBreathPeriod = maxBreathPeriod;
  }

  estimate(signal, sampleRate) {
    const n = signal.length;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;
    const centered = new Float32Array(n);
    for (let i = 0; i < n; i++) centered[i] = signal[i] - mean;

    const maxLag = Math.min(n - 1, Math.floor(this.maxBreathPeriod * sampleRate));
    const minLag = Math.max(1, Math.floor(this.minBreathPeriod * sampleRate));

    const acorr = new Float32Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += centered[i] * centered[i + lag];
      acorr[lag] = sum;
    }
    const r0 = acorr[0] || 1;
    for (let lag = 0; lag <= maxLag; lag++) acorr[lag] /= r0;

    let bestLag = -1, bestVal = -Infinity;
    for (let lag = minLag; lag < maxLag - 1; lag++) {
      const isPeak = acorr[lag] > acorr[lag - 1] && acorr[lag] > acorr[lag + 1];
      if (isPeak && acorr[lag] > bestVal) { bestVal = acorr[lag]; bestLag = lag; break; }
    }

    let sigMin = Infinity, sigMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (signal[i] < sigMin) sigMin = signal[i];
      if (signal[i] > sigMax) sigMax = signal[i];
    }
    const amp = sigMax - sigMin > 0 ? sigMax - sigMin : 0.5;

    if (bestLag < 0 || bestVal <= 0) {
      const fallback = new PeakDetectionEstimator({
        minBreathPeriod: this.minBreathPeriod,
        maxBreathPeriod: this.maxBreathPeriod,
      });
      const result = fallback.estimate(signal, sampleRate);
      if (result) {
        console.log('[AutocorrEstimator] autocorr peak not found — using peak-detection fallback');
        return result;
      }
      console.warn('[AutocorrEstimator] both methods failed — using 4 s default');
    }

    const periodSeconds = (bestLag > 0 ? bestLag : 4 * sampleRate) / sampleRate;
    return { freq: (2 * Math.PI) / periodSeconds, amp };
  }
}


// ── PeakDetectionEstimator ────────────────────────────────────────────────────

/**
 * Peak-detection + inter-peak averaging frequency estimator for sine synthesis.
 * Matches the MATLAB iBreath fallback approach.
 * Returns { freq (rad/s), amp } or null if estimation fails.
 *
 * @param {{ minBreathPeriod?, maxBreathPeriod? }} [opts]
 */
export class PeakDetectionEstimator extends FrequencyEstimator {
  constructor({ minBreathPeriod = 2, maxBreathPeriod = 12 } = {}) {
    super();
    this.minBreathPeriod = minBreathPeriod;
    this.maxBreathPeriod = maxBreathPeriod;
  }

  estimate(signal, sampleRate) {
    const n = signal.length;
    let sigMin = Infinity, sigMax = -Infinity, sigMean = 0;
    for (let i = 0; i < n; i++) {
      if (signal[i] < sigMin) sigMin = signal[i];
      if (signal[i] > sigMax) sigMax = signal[i];
      sigMean += signal[i];
    }
    sigMean /= n;
    const amp = sigMax - sigMin > 0 ? sigMax - sigMin : 0.5;

    const peaks = [];
    for (let i = 1; i < n - 1; i++) {
      if (signal[i] > signal[i - 1] && signal[i] > signal[i + 1] && signal[i] > sigMean) {
        peaks.push(i);
      }
    }
    if (peaks.length < 2) return null;

    const minSamples = Math.floor(this.minBreathPeriod * sampleRate);
    const maxSamples = Math.ceil(this.maxBreathPeriod * sampleRate);
    const intervals  = [];
    for (let i = 1; i < peaks.length; i++) {
      const gap = peaks[i] - peaks[i - 1];
      if (gap >= minSamples && gap <= maxSamples) intervals.push(gap);
    }
    if (intervals.length === 0) return null;

    const periodSeconds = (intervals.reduce((a, b) => a + b, 0) / intervals.length) / sampleRate;
    return { freq: (2 * Math.PI) / periodSeconds, amp };
  }
}


// ── cleanSignal ───────────────────────────────────────────────────────────────

/**
 * Zero-phase first-order Butterworth bandpass filter, following neurokit2's
 * rsp_clean() approach (0.05–3 Hz default).  Applied with reflect padding to
 * reduce edge transients (equivalent to scipy's filtfilt pad mode).
 *
 * @param {ArrayLike<number>} signal
 * @param {number} sampleRate  Samples per second
 * @param {{ lowCut?: number, highCut?: number }} [opts]
 * @returns {Float64Array}
 */
export function cleanSignal(signal, sampleRate, { lowCut = 0.05, highCut = 3.0 } = {}) {
  const s = _toF64(signal);
  const n = s.length;
  if (n < 2) return s.slice();

  // ── High-pass (remove drift below lowCut Hz) ──────────────────────────────
  // RC-type: y[n] = α·(y[n−1] + x[n] − x[n−1])  →  b0=α, b1=−α, a1=−α
  const tauHP  = 1 / (2 * Math.PI * lowCut);
  const alphaHP = tauHP * sampleRate / (tauHP * sampleRate + 1);
  const padHP  = Math.min(Math.floor(3 * tauHP * sampleRate), Math.floor(n / 4));

  const paddedHP = _reflectPad(s, padHP);
  const filtHP   = _filtfilt1(paddedHP, alphaHP, -alphaHP, -alphaHP);
  let filtered   = filtHP.slice(padHP, padHP + n);

  // ── Low-pass (remove noise above highCut Hz) — skip if near Nyquist ──────
  if (sampleRate > 4 * highCut) {
    const tauLP   = 1 / (2 * Math.PI * highCut);
    const alphaLP = 1 / (tauLP * sampleRate + 1);
    // Leaky integrator: y[n] = αLP·x[n] + (1−αLP)·y[n−1]  →  b0=αLP, b1=0, a1=αLP−1
    const padLP    = Math.min(Math.floor(3 * tauLP * sampleRate), Math.floor(n / 4));
    const paddedLP = _reflectPad(filtered, padLP);
    const filtLP   = _filtfilt1(paddedLP, alphaLP, 0, alphaLP - 1);
    filtered = filtLP.slice(padLP, padLP + n);
  }

  return filtered;
}


// ── AutocorrRateEstimator ─────────────────────────────────────────────────────

/**
 * Autocorrelation-based breath rate estimator.
 * Returns the frequency (Hz) corresponding to the first prominent positive lag
 * peak in the normalised autocorrelation of the (optionally cleaned) signal.
 *
 * @param {{ minPeriod?, maxPeriod?, clean?, windowSecs? }} [opts]
 */
export class AutocorrRateEstimator {
  constructor({
    minPeriod  = 2,    // seconds
    maxPeriod  = 12,
    clean      = true,
    windowSecs = null,
  } = {}) {
    this.minPeriod  = minPeriod;
    this.maxPeriod  = maxPeriod;
    this.clean      = clean;
    this.windowSecs = windowSecs;
  }

  estimate(signal, sampleRate) {
    const raw = _toF64(signal);
    const s   = this.clean ? cleanSignal(raw, sampleRate) : raw;
    if (this.windowSecs !== null) {
      return _meanNonNull(_slidingWindows(s, sampleRate, this.windowSecs)
        .map(w => this._window(w, sampleRate)));
    }
    return this._window(s, sampleRate);
  }

  _window(s, sampleRate) {
    const n      = s.length;
    const minLag = Math.max(1, Math.floor(this.minPeriod * sampleRate));
    const maxLag = Math.min(n - 1, Math.floor(this.maxPeriod * sampleRate));
    if (maxLag <= minLag) return null;

    // Remove DC
    let mean = 0;
    for (let i = 0; i < n; i++) mean += s[i];
    mean /= n;
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = s[i] - mean;

    // Normalised autocorrelation up to maxLag
    const acorr = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += c[i] * c[i + lag];
      acorr[lag] = sum;
    }
    const r0 = acorr[0] || 1;
    for (let lag = 0; lag <= maxLag; lag++) acorr[lag] /= r0;

    // First prominent positive peak after minLag
    for (let lag = minLag; lag < maxLag - 1; lag++) {
      if (acorr[lag] > acorr[lag - 1] && acorr[lag] > acorr[lag + 1] && acorr[lag] > 0) {
        return sampleRate / lag;  // Hz
      }
    }
    return null;
  }
}


// ── PeakTroughEstimator ───────────────────────────────────────────────────────

/**
 * Trough-interval breath rate estimator, based on neurokit2's "trough" method.
 * Finds local minima below the signal mean, computes inter-trough intervals,
 * filters to the physiological range, and averages.
 *
 * @param {{ minPeriod?, maxPeriod?, clean? }} [opts]
 */
export class PeakTroughEstimator {
  constructor({ minPeriod = 2, maxPeriod = 12, clean = true } = {}) {
    this.minPeriod = minPeriod;
    this.maxPeriod = maxPeriod;
    this.clean     = clean;
  }

  estimate(signal, sampleRate) {
    const raw = _toF64(signal);
    const s   = this.clean ? cleanSignal(raw, sampleRate) : raw;
    const n   = s.length;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += s[i];
    mean /= n;

    // Local minima below the signal mean
    const troughs = [];
    for (let i = 1; i < n - 1; i++) {
      if (s[i] < s[i - 1] && s[i] < s[i + 1] && s[i] < mean) troughs.push(i);
    }
    if (troughs.length < 2) return null;

    const minSamp = Math.floor(this.minPeriod * sampleRate);
    const maxSamp = Math.ceil(this.maxPeriod * sampleRate);
    const valid   = [];
    for (let i = 1; i < troughs.length; i++) {
      const gap = troughs[i] - troughs[i - 1];
      if (gap >= minSamp && gap <= maxSamp) valid.push(gap);
    }
    if (valid.length === 0) return null;

    const periodSec = (valid.reduce((a, b) => a + b, 0) / valid.length) / sampleRate;
    return 1 / periodSec;
  }
}


// ── WelchEstimator ────────────────────────────────────────────────────────────

/**
 * Welch power-spectral-density breath rate estimator.
 * Divides the signal into overlapping Hann-windowed segments, accumulates
 * per-frequency Goertzel power, and returns the peak frequency in the
 * physiological range.  Returns null if the signal is too short.
 *
 * @param {{ clean?, windowSecs?, minFreq?, maxFreq?, freqStep?, minSignalSecs? }} [opts]
 */
export class WelchEstimator {
  constructor({
    clean         = true,
    windowSecs    = null,
    minFreq       = 0.05,
    maxFreq       = 1.0,
    freqStep      = 0.01,
    minSignalSecs = 20,
  } = {}) {
    this.clean         = clean;
    this.windowSecs    = windowSecs;
    this.minFreq       = minFreq;
    this.maxFreq       = maxFreq;
    this.freqStep      = freqStep;
    this.minSignalSecs = minSignalSecs;
  }

  estimate(signal, sampleRate) {
    const raw = _toF64(signal);
    const s   = this.clean ? cleanSignal(raw, sampleRate) : raw;
    if (this.windowSecs !== null) {
      return _meanNonNull(_slidingWindows(s, sampleRate, this.windowSecs)
        .map(w => this._window(w, sampleRate)));
    }
    return this._window(s, sampleRate);
  }

  _window(s, sampleRate) {
    const minLen = Math.floor(this.minSignalSecs * sampleRate);
    if (s.length < minLen) return null;

    // Internal Welch segments: use half the signal length (≥ minSignalSecs)
    const segLen = Math.max(minLen, Math.floor(s.length * 0.5));
    const step   = Math.max(1, Math.floor(segLen * 0.5));

    // Build frequency array
    const freqs = [];
    for (let f = this.minFreq; f <= this.maxFreq + 1e-9; f += this.freqStep) freqs.push(f);
    if (freqs.length === 0) return null;

    // Accumulate Goertzel power across Hann-windowed segments
    const power = new Float64Array(freqs.length);
    let segCount = 0;
    for (let start = 0; start + segLen <= s.length; start += step) {
      const seg = _hann(s.slice(start, start + segLen));
      for (let fi = 0; fi < freqs.length; fi++) {
        power[fi] += _goertzelPower(seg, freqs[fi], sampleRate);
      }
      segCount++;
    }
    if (segCount === 0) return null;

    let bestIdx = 0;
    for (let fi = 1; fi < freqs.length; fi++) {
      if (power[fi] > power[bestIdx]) bestIdx = fi;
    }
    return freqs[bestIdx];
  }
}


// ── XcorrEstimator ────────────────────────────────────────────────────────────

/**
 * Cross-correlation breath rate estimator, following neurokit2's 'xcorr' method.
 * Cross-correlates the signal with template sinusoids at candidate frequencies
 * (equivalent to evaluating the DFT at those frequencies) and returns the
 * frequency with the highest correlation power.
 *
 * @param {{ clean?, windowSecs?, minFreq?, maxFreq?, freqStep? }} [opts]
 */
export class XcorrEstimator {
  constructor({
    clean      = true,
    windowSecs = null,
    minFreq    = 0.05,
    maxFreq    = 1.0,
    freqStep   = 0.005,
  } = {}) {
    this.clean      = clean;
    this.windowSecs = windowSecs;
    this.minFreq    = minFreq;
    this.maxFreq    = maxFreq;
    this.freqStep   = freqStep;
  }

  estimate(signal, sampleRate) {
    const raw = _toF64(signal);
    const s   = this.clean ? cleanSignal(raw, sampleRate) : raw;
    if (this.windowSecs !== null) {
      return _meanNonNull(_slidingWindows(s, sampleRate, this.windowSecs)
        .map(w => this._window(w, sampleRate)));
    }
    return this._window(s, sampleRate);
  }

  _window(s, sampleRate) {
    const n = s.length;
    if (n < 2) return null;

    // Remove DC
    let mean = 0;
    for (let i = 0; i < n; i++) mean += s[i];
    mean /= n;
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = s[i] - mean;

    // Sweep candidate frequencies; compute DFT power at each (= xcorr with sin+cos)
    let bestFreq  = null;
    let bestPower = -Infinity;
    for (let f = this.minFreq; f <= this.maxFreq + 1e-9; f += this.freqStep) {
      let sumSin = 0, sumCos = 0;
      for (let i = 0; i < n; i++) {
        const phi = 2 * Math.PI * f * (i / sampleRate);
        sumSin += c[i] * Math.sin(phi);
        sumCos += c[i] * Math.cos(phi);
      }
      const pwr = sumSin * sumSin + sumCos * sumCos;
      if (pwr > bestPower) { bestPower = pwr; bestFreq = f; }
    }
    return bestFreq;
  }
}


// ── estimateBreathRate ────────────────────────────────────────────────────────

/**
 * Run all estimators and return results as a flat dict (Hz | null per key).
 *
 * Non-windowed methods always run: autocorr, peakTrough, welch, xcorr.
 * When windowed is true, autocorr, welch, and xcorr are also run with a
 * sliding window (default 30 s, 50 % overlap) and added as
 * autocorr_windowed, welch_windowed, xcorr_windowed.
 *
 * @param {ArrayLike<number>} signal
 * @param {number} sampleRate
 * @param {{
 *   autocorr?:   object,   peakTrough?: object,
 *   welch?:      object,   xcorr?:      object,
 *   windowed?:   boolean,  windowSecs?: number,
 * }} [opts]
 * @returns {Record<string, number|null>}
 */
export function estimateBreathRate(signal, sampleRate, {
  autocorr   = {},
  peakTrough = {},
  welch      = {},
  xcorr      = {},
  windowed   = false,
  windowSecs = 30,
} = {}) {
  const s = _toF64(signal);

  const result = {
    autocorr:   new AutocorrRateEstimator(autocorr).estimate(s, sampleRate),
    peakTrough: new PeakTroughEstimator(peakTrough).estimate(s, sampleRate),
    welch:      new WelchEstimator(welch).estimate(s, sampleRate),
    xcorr:      new XcorrEstimator(xcorr).estimate(s, sampleRate),
  };

  if (windowed) {
    result.autocorr_windowed = new AutocorrRateEstimator({ ...autocorr, windowSecs }).estimate(s, sampleRate);
    result.welch_windowed    = new WelchEstimator({ ...welch, windowSecs }).estimate(s, sampleRate);
    result.xcorr_windowed    = new XcorrEstimator({ ...xcorr, windowSecs }).estimate(s, sampleRate);
  }

  return result;
}
