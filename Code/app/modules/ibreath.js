/**
 * ibreath.js — iBreath experiment frontend
 * =========================================
 * Port of ibreath_main_v2.m to the RespFish Electron frontend architecture.
 *
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 *
 * State machine:
 *   IDLE → CALIBRATING → READY → TRIAL → ITI → DONE
 *
 * Usage (renderer.js sets FRONTEND = 'ibreath'):
 *   const frontend = new IBreath({ statsContainer, sceneContainer });
 *   frontend.pushSample(value);
 *   frontend.setStatus({ type, text });
 */

import {
  GaussianSmoother,
  AutocorrEstimator,
  AsyncSignalGenerator,
  logScale,
  mapRange,
} from "./signalUtils.js";

// ── Configuration ─────────────────────────────────────────────────────────────
// Mirrors the constants in ibreath_main_v2.m

export const CONFIG = {
  // Subject / experiment
  SUBJECT_CODE: "TEST",           // set via experimenter HUD before starting

  // Signal scaling  (matching MATLAB LOG_SCALING_SYNC path)
  LOG_SCALE_DEPTH:      500,
  BREATH_SCALE_BASE_LOG: 1.2,

  // Smoothing
  SMOOTH_WINDOW: 64,              // samples (matches smoothBreathRT.m windowSize)

  // Calibration
  CALIBRATION_SECS: 10,           // seconds to record before first trial

  // Trial timing
  MAX_NUM_TRIALS:   80,
  MAX_TRIAL_TIME:   30,           // seconds
  MIN_TRIAL_TIME:    5,           // seconds
  ITI_MIN:        2000,           // ms
  ITI_MAX:        3000,           // ms

  // Async signal
  SPEED_FACTOR_SLOW: 1.1,
  SPEED_FACTOR_FAST: 0.9,

  // Noise
  ADD_NOISE_ASYNC: true,
  MAP_ASYNC_RANGE_TO_SYNC_RANGE: true,

  // Image layout
  STIMULUS_HALF_WIDTH: true,      // image fills one half of the scene (left or right)

  // Zoom
  // zoomRect.m: factor 0 → original, factor 1 → 1/maxZoom of original
  ZOOM_MAX_FACTOR: 2,             // matches maxZoom = 2 in zoomRect.m

  // Data output base directory (relative to electron/ app dir)
  DATA_DIR: "subjectData",
};

// ── State labels ──────────────────────────────────────────────────────────────

const STATE = {
  IDLE:        'idle',
  CALIBRATING: 'calibrating',
  READY:       'ready',        // between trials — waiting for experimenter
  TRIAL:       'trial',
  ITI:         'iti',
  DONE:        'done',
};

// ── Trial param generator ─────────────────────────────────────────────────────
// Mirrors makeTrialData.m and the lr/sf/sa balanced-sequence logic.

function makeTrialParams(numTrials) {
  // Balanced pseudo-random boolean sequences in blocks of `blockSize`
  function balancedSeq(length, blockSize) {
    const out = [];
    while (out.length < length) {
      const block = [];
      for (let i = 0; i < blockSize; i++) block.push(i % 2 === 0);
      // Fisher-Yates shuffle
      for (let i = block.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [block[i], block[j]] = [block[j], block[i]];
      }
      out.push(...block);
    }
    return out.slice(0, length);
  }

  const lrSeq = balancedSeq(numTrials, 4);         // left/right
  const saSeq = balancedSeq(numTrials, 2);          // sync/async alternating
  const numAsync = Math.floor(numTrials / 2);
  const sfSeq = balancedSeq(numAsync, 4);           // slow/fast (async only)

  // Two stimulus images — one for sync, one for async (randomised assignment)
  const imgNums = Math.random() < 0.5 ? [1, 2] : [2, 1];
  const syncImg  = `media/stimulus_${imgNums[0]}.png`;
  const asyncImg = `media/stimulus_${imgNums[1]}.png`;

  const trials = [];
  let asyncIdx = 0;

  for (let i = 0; i < numTrials; i++) {
    const sync = saSeq[i];
    const iti  = CONFIG.ITI_MIN +
                 Math.round(Math.random() * (CONFIG.ITI_MAX - CONFIG.ITI_MIN));

    const trial = {
      trialIndex:   i + 1,
      synchronous:  sync,
      img:          sync ? syncImg : asyncImg,
      lr:           lrSeq[i],          // true = left, false = right
      ITI:          iti,               // ms
      slowfast:     null,              // only set for async trials
      startTime:    null,
      endTime:      null,
    };

    if (!sync) {
      trial.slowfast = sfSeq[asyncIdx % sfSeq.length]; // true = slow
      asyncIdx++;
    }

    trials.push(trial);
  }
  return trials;
}

// ── zoomRect helper ───────────────────────────────────────────────────────────
// Port of zoomRect.m — returns a sub-rectangle that "zooms in" as factor → 1.
// rect = { x, y, w, h }  (source image coordinates)

function zoomRect(rect, factor) {
  const maxZoom = CONFIG.ZOOM_MAX_FACTOR;
  factor = Math.max(0, Math.min(1, factor));
  const zw = rect.w - (factor * (1 / maxZoom) * rect.w);
  const zh = rect.h - (factor * (1 / maxZoom) * rect.h);
  const zx = rect.x + (rect.w - zw);
  const zy = rect.y + (rect.h - zh);
  return { x: zx, y: zy, w: zw, h: zh };
}

// ── IBreath ───────────────────────────────────────────────────────────────────

export default class IBreath {
  // ── state ──────────────────────────────────────────────────────────────────
  #state          = STATE.IDLE;
  #streamReady    = false;

  // ── experiment data ────────────────────────────────────────────────────────
  #subjectCode    = CONFIG.SUBJECT_CODE;
  #trials         = [];
  #trialIndex     = 0;           // 0-based index into #trials
  #trialData      = [];          // completed trial records (for trialData.csv)

  // ── calibration ────────────────────────────────────────────────────────────
  #calStartTime   = null;
  #calSamples     = [];          // raw (log-scaled) samples during calibration
  #calStimulusLevels = [];       // smoothed stimulus levels during calibration

  // ── signal pipeline ────────────────────────────────────────────────────────
  #smoother       = new GaussianSmoother(CONFIG.SMOOTH_WINDOW);
  #asyncGen       = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });
  #syncStimulusRange = [0.3, 0.4];  // updated after each sync trial

  // ── per-trial state ────────────────────────────────────────────────────────
  #trialStartTime     = null;
  #stimulusLevel      = 0;
  #lastRawSample      = 0;
  #lastScaledSample   = 0;
  #syncSignal         = [];      // scaled samples collected during sync trial
  #syncStimulusSignal = [];      // stimulus levels during sync trial
  #frameRows          = [];      // per-frame CSV rows buffered during trial

  // ── ITI ────────────────────────────────────────────────────────────────────
  #itiStartTime   = null;
  #itiDuration    = 0;

  // ── image cache ────────────────────────────────────────────────────────────
  #imgCache       = {};          // url → HTMLImageElement
  #currentImg     = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  #canvas         = null;
  #ctx            = null;
  #stateEl        = null;
  #trialEl        = null;
  #subjectInput   = null;
  #startBtn       = null;
  #nextBtn        = null;
  #abortBtn       = null;
  #hudEl          = null;

  constructor({ statsContainer, sceneContainer }) {
    this.#buildHUD(statsContainer);
    this.#buildScene(sceneContainer);
    this.#bindKeys();
    requestAnimationFrame(() => this.#loop());
  }

  // ── Frontend interface ─────────────────────────────────────────────────────

  pushSample(rawValue) {
    // rawValue is already in [0, 1] from the LSL bridge
    // Apply log scaling matching the MATLAB pipeline
    const scaled = logScale(rawValue, CONFIG.LOG_SCALE_DEPTH)
                   * CONFIG.BREATH_SCALE_BASE_LOG;

    this.#lastRawSample    = rawValue;
    this.#lastScaledSample = scaled;
    this.#smoother.push(scaled);

    if (this.#state === STATE.CALIBRATING) {
      this.#calSamples.push(scaled);
      this.#calStimulusLevels.push(this.#smoother.value);
    } else if (this.#state === STATE.TRIAL) {
      this.#onTrialSample(scaled);
    }
  }

  setStatus({ type, text }) {
    this.#streamReady = (type === 'connected');
    if (this.#state === STATE.IDLE) {
      this.#stateEl.textContent = this.#streamReady
        ? 'stream ready — enter subject code and press Start'
        : text;
      this.#startBtn.disabled = !this.#streamReady;
    }
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  #buildHUD(container) {
    container.innerHTML = `
      <span id="ib-state-text">waiting for stream…</span>
      <span>
        <span class="label">trial</span>
        <span id="ib-trial">—</span>
      </span>
      <span>
        <span class="label">subject</span>
        <input id="ib-subject" type="text" value="${CONFIG.SUBJECT_CODE}"
               placeholder="subject code" autocomplete="off" spellcheck="false" />
      </span>
      <span id="ib-controls">
        <button id="ib-start-btn"  disabled>Start</button>
        <button id="ib-next-btn"   style="display:none">Next trial</button>
        <button id="ib-abort-btn"  style="display:none">Abort trial</button>
      </span>
    `;
    this.#stateEl      = container.querySelector('#ib-state-text');
    this.#trialEl      = container.querySelector('#ib-trial');
    this.#subjectInput = container.querySelector('#ib-subject');
    this.#startBtn     = container.querySelector('#ib-start-btn');
    this.#nextBtn      = container.querySelector('#ib-next-btn');
    this.#abortBtn     = container.querySelector('#ib-abort-btn');
    this.#hudEl        = container;

    this.#startBtn.addEventListener('click', () => this.#beginCalibration());
    this.#nextBtn.addEventListener('click',  () => this.#advanceTrial());
    this.#abortBtn.addEventListener('click', () => this.#abortTrial());
  }

  #buildScene(container) {
    container.innerHTML = '<canvas id="ib-canvas"></canvas>';
    this.#canvas = container.querySelector('#ib-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  #bindKeys() {
    window.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (this.#state === STATE.READY) this.#advanceTrial();
          break;
        case 'Escape':
          if (this.#state === STATE.TRIAL) this.#abortTrial();
          break;
        case 'KeyP':
          // reserved for pause — no-op for now, handled in future WP
          break;
      }
    });
  }

  // ── State machine ──────────────────────────────────────────────────────────

  #beginCalibration() {
    this.#subjectCode = this.#subjectInput.value.trim() || 'TEST';
    this.#trials      = makeTrialParams(CONFIG.MAX_NUM_TRIALS);
    this.#trialIndex  = 0;
    this.#trialData   = [];

    this.#calSamples         = [];
    this.#calStimulusLevels  = [];
    this.#calStartTime       = performance.now();
    this.#smoother.reset();

    this.#state = STATE.CALIBRATING;
    this.#startBtn.disabled = true;
    this.#subjectInput.disabled = true;
    this.#stateEl.textContent = 'calibrating…';
  }

  #finishCalibration() {
    // Estimate async params from the calibration signal
    // sampleRate: count / duration
    const durationSecs = CONFIG.CALIBRATION_SECS;
    const sampleRate   = this.#calSamples.length / durationSecs;

    this.#asyncGen.calibrate(
      this.#calSamples,
      sampleRate,
      null   // syncRange not known yet — will be updated after first sync trial
    );

    // Seed the syncStimulusRange from calibration levels (matching MATLAB pre-recording)
    const lvls = this.#calStimulusLevels;
    const lvlMin = Math.min(...lvls);
    const lvlMax = Math.max(...lvls);
    this.#syncStimulusRange = [lvlMin * 0.8, lvlMax * 0.8];

    this.#state = STATE.READY;
    this.#stateEl.textContent = 'ready — press Space or Next trial to begin';
    this.#nextBtn.style.display = '';
    this.#trialEl.textContent = `0 / ${this.#trials.length}`;
  }

  #advanceTrial() {
    if (this.#trialIndex >= this.#trials.length) {
      this.#endExperiment();
      return;
    }

    const trial = this.#trials[this.#trialIndex];

    // Determine speed factor for async trials
    if (!trial.synchronous) {
      const factor = trial.slowfast
        ? CONFIG.SPEED_FACTOR_SLOW
        : CONFIG.SPEED_FACTOR_FAST;
      this.#asyncGen.setSpeedFactor(factor);

      // Re-calibrate async range mapping from most recent sync range
      if (CONFIG.MAP_ASYNC_RANGE_TO_SYNC_RANGE) {
        this.#asyncGen.calibrate(
          new Float32Array(this.#calSamples),  // keep existing freq/amp/phase
          this.#calSamples.length / CONFIG.CALIBRATION_SECS,
          this.#syncStimulusRange
        );
      }
    }

    // Pre-load the trial image
    this.#loadImage(trial.img);

    // Reset per-trial buffers
    this.#syncSignal         = [];
    this.#syncStimulusSignal = [];
    this.#frameRows          = [];
    this.#stimulusLevel      = 0;
    this.#smoother.reset();

    // Pre-fill smoother with 64 samples (matching MATLAB pre-buffer)
    // We can't block here, so we fill with the last known scaled value
    for (let i = 0; i < CONFIG.SMOOTH_WINDOW; i++) {
      this.#smoother.push(this.#lastScaledSample);
    }
    if (trial.synchronous) {
      for (let i = 0; i < CONFIG.SMOOTH_WINDOW; i++) {
        this.#syncSignal.push(this.#lastScaledSample);
      }
    }

    this.#trialStartTime = performance.now();
    trial.startTime = new Date().toISOString();

    this.#state = STATE.TRIAL;
    this.#nextBtn.style.display  = 'none';
    this.#abortBtn.style.display = '';
    this.#stateEl.textContent    = trial.synchronous ? 'sync trial' : 'async trial';
    this.#trialEl.textContent    =
      `${this.#trialIndex + 1} / ${this.#trials.length}`;
  }

  #onTrialSample(scaled) {
    const trial = this.#trials[this.#trialIndex];

    if (trial.synchronous) {
      this.#syncSignal.push(scaled);
      this.#stimulusLevel = this.#smoother.value;
      this.#syncStimulusSignal.push(this.#stimulusLevel);
    }
    // async stimulus level is computed in #loop via asyncGen.sample(t)
  }

  #endTrial(aborted = false) {
    const trial      = this.#trials[this.#trialIndex];
    trial.endTime    = new Date().toISOString();
    trial.aborted    = aborted;

    // Post-trial: update async params from sync signal
    if (trial.synchronous && this.#syncSignal.length > CONFIG.SMOOTH_WINDOW) {
      // Strip the 64-sample pre-buffer (matches syncSignal(65:end) in MATLAB)
      const cleanSignal = new Float32Array(
        this.#syncSignal.slice(CONFIG.SMOOTH_WINDOW)
      );
      const sampleRate = cleanSignal.length /
        ((performance.now() - this.#trialStartTime) / 1000);

      this.#asyncGen.calibrate(cleanSignal, sampleRate, this.#syncStimulusRange);

      // Update sync range from this trial's stimulus levels
      const lvls = this.#syncStimulusSignal;
      const lvlMin = Math.min(...lvls);
      const lvlMax = Math.max(...lvls);
      this.#syncStimulusRange = [lvlMin, lvlMax];
    }

    // Write CSVs (WP6 will wire these up fully; stubs are in place)
    this.#writeFrameCSV(trial);
    this.#appendTrialDataCSV(trial);

    this.#trialData.push({ ...trial });
    this.#trialIndex++;

    if (this.#trialIndex >= this.#trials.length) {
      this.#endExperiment();
      return;
    }

    // Start ITI
    this.#itiStartTime = performance.now();
    this.#itiDuration  = trial.ITI;
    this.#state        = STATE.ITI;
    this.#abortBtn.style.display = 'none';
    this.#stateEl.textContent = 'inter-trial interval…';
  }

  #abortTrial() {
    this.#endTrial(true);
  }

  #endExperiment() {
    this.#state = STATE.DONE;
    this.#nextBtn.style.display  = 'none';
    this.#abortBtn.style.display = 'none';
    this.#stateEl.textContent = 'experiment complete';
    this.#trialEl.textContent = `${this.#trials.length} / ${this.#trials.length}`;
  }

  // ── Main animation loop ────────────────────────────────────────────────────

  #loop() {
    const canvas = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const now = performance.now();

    // ITI auto-advance
    if (this.#state === STATE.ITI) {
      if (now - this.#itiStartTime >= this.#itiDuration) {
        this.#state = STATE.READY;
        this.#nextBtn.style.display = '';
        this.#stateEl.textContent = 'ready — press Space or Next trial';
      }
    }

    this.#draw(now);
    requestAnimationFrame(() => this.#loop());
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  #draw(now) {
    const ctx = this.#ctx;
    const w   = this.#canvas.width;
    const h   = this.#canvas.height;
    ctx.clearRect(0, 0, w, h);

    switch (this.#state) {
      case STATE.IDLE:        return this.#drawIdle(ctx, w, h);
      case STATE.CALIBRATING: return this.#drawCalibrating(ctx, w, h, now);
      case STATE.READY:       return this.#drawReady(ctx, w, h);
      case STATE.TRIAL:       return this.#drawTrial(ctx, w, h, now);
      case STATE.ITI:         return this.#drawITI(ctx, w, h, now);
      case STATE.DONE:        return this.#drawDone(ctx, w, h);
    }
  }

  #drawIdle(ctx, w, h) {
    this.#centreText(ctx, w, h, 'waiting for stream…', 'rgba(255,255,255,0.4)', 18);
  }

  #drawCalibrating(ctx, w, h, now) {
    const elapsed  = now - this.#calStartTime;
    const progress = Math.min(elapsed / (CONFIG.CALIBRATION_SECS * 1000), 1);
    const remaining = Math.max(0, Math.ceil(CONFIG.CALIBRATION_SECS - elapsed / 1000));
    const cx = w / 2, cy = h / 2;
    const r  = 60;

    // Check for completion
    if (progress >= 1) {
      this.#finishCalibration();
      return;
    }

    // Instruction
    this.#centreText(ctx, w, cy - 80,
      'Breathe normally…', 'rgba(255,255,255,0.85)', 20);

    // Track ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 5;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Countdown
    this.#centreText(ctx, cx, cy, String(remaining),
      'rgba(255,255,255,0.7)', 52, '200');
  }

  #drawReady(ctx, w, h) {
    this.#centreText(ctx, w / 2, h / 2,
      'Press Space or "Next trial" to begin',
      'rgba(255,255,255,0.35)', 18);
  }

  #drawTrial(ctx, w, h, now) {
    const trial     = this.#trials[this.#trialIndex];
    const tSecs     = (now - this.#trialStartTime) / 1000;

    // Compute stimulus level
    let stimLevel;
    if (trial.synchronous) {
      stimLevel = this.#stimulusLevel;  // updated in #onTrialSample
    } else {
      stimLevel = this.#asyncGen.sample(tSecs);
      this.#stimulusLevel = stimLevel;
    }

    // Clamp to [0, 1]
    stimLevel = Math.max(0, Math.min(1, stimLevel));

    // Record frame data for CSV
    this.#frameRows.push({
      t:      new Date().toISOString(),
      gaze_x: window.gazeState?.x ?? 0,
      gaze_y: window.gazeState?.y ?? 0,
      raw:    this.#lastRawSample,
      scaled: this.#lastScaledSample,
      stim:   stimLevel,
    });

    // Auto-end trial when max time reached
    if (tSecs >= CONFIG.MAX_TRIAL_TIME) {
      this.#endTrial(false);
      return;
    }

    // Draw stimulus image with zoom
    const img = this.#currentImg;
    if (!img || !img.complete) {
      this.#centreText(ctx, w / 2, h / 2, 'loading…',
        'rgba(255,255,255,0.3)', 16);
      return;
    }

    // Destination rect: left or right half of scene
    const destX = trial.lr ? 0 : w / 2;
    const destW = w / 2;
    const destH = h;

    // Source rect: zoomRect applied to full image
    const src = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const z   = zoomRect(src, stimLevel);

    ctx.drawImage(
      img,
      z.x, z.y, z.w, z.h,        // source (zoomed crop)
      destX, 0, destW, destH      // destination (half screen)
    );

    // Soft vignette overlay on image half
    this.#drawVignette(ctx, destX, 0, destW, destH);
  }

  #drawITI(ctx, w, h, now) {
    const remaining = Math.max(0,
      this.#itiDuration - (now - this.#itiStartTime));
    const secs = (remaining / 1000).toFixed(1);
    this.#centreText(ctx, w / 2, h / 2,
      `Next trial in ${secs}s`,
      'rgba(255,255,255,0.2)', 16);
  }

  #drawDone(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    this.#centreText(ctx, cx, cy - 40,
      'Experiment complete', 'rgba(255,255,255,0.6)', 24);
    this.#centreText(ctx, cx, cy + 10,
      `${this.#trialData.length} trials recorded`,
      'rgba(255,255,255,0.35)', 16);
    this.#centreText(ctx, cx, cy + 50,
      `Subject: ${this.#subjectCode}`,
      'rgba(255,255,255,0.25)', 14);
  }

  // ── Scene helpers ──────────────────────────────────────────────────────────

  /**
   * Soft radial vignette over the stimulus area — adds visual polish without
   * altering the perceived zoom effect.
   */
  #drawVignette(ctx, x, y, w, h) {
    const grd = ctx.createRadialGradient(
      x + w / 2, y + h / 2, h * 0.25,
      x + w / 2, y + h / 2, h * 0.8
    );
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = grd;
    ctx.fillRect(x, y, w, h);
  }

  /**
   * Draws centred text. y may be a y-coordinate or h/2 implicitly.
   */
  #centreText(ctx, x, y, text, color, size, weight = '300') {
    ctx.fillStyle    = color;
    ctx.font         = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  // ── Image loading ──────────────────────────────────────────────────────────

  #loadImage(src) {
    if (this.#imgCache[src]) {
      this.#currentImg = this.#imgCache[src];
      return;
    }
    const img = new Image();
    img.src = src;
    img.onload = () => {
      this.#imgCache[src] = img;
      if (this.#trials[this.#trialIndex]?.img === src) {
        this.#currentImg = img;
      }
    };
    // Show placeholder while loading
    this.#currentImg = null;
    this.#imgCache[src] = img;
  }

  // ── CSV output (stubs — fully wired in WP6) ────────────────────────────────

  async #writeFrameCSV(trial) {
    if (!window.api) return;
    const dir  = `${CONFIG.DATA_DIR}/${this.#subjectCode}`;
    const file = `${dir}/frameData_${trial.trialIndex}.csv`;
    const header = 'trialIndex,timestamp,gaze_x,gaze_y,' +
                   'breathLevel_input,breathLevel_scaled,stimulusLevel\n';
    const rows = this.#frameRows.map(r =>
      `${trial.trialIndex},${r.t},${r.gaze_x},${r.gaze_y},` +
      `${r.raw.toFixed(6)},${r.scaled.toFixed(6)},${r.stim.toFixed(6)}`
    ).join('\n');
    await window.api.writeCSV(file, header + rows + '\n');
  }

  async #appendTrialDataCSV(trial) {
    if (!window.api) return;
    const dir  = `${CONFIG.DATA_DIR}/${this.#subjectCode}`;
    const file = `${dir}/trialData.csv`;
    const header = 'trialIndex,subject,synchronous,img,lr,slowfast,' +
                   'ITI,startTime,endTime,aborted\n';

    // Write header only for first trial
    if (this.#trialIndex === 1) {
      await window.api.writeCSV(file, header);
    }

    const row =
      `${trial.trialIndex},${this.#subjectCode},${trial.synchronous},` +
      `${trial.img},${trial.lr},${trial.slowfast ?? ''},` +
      `${trial.ITI},${trial.startTime},${trial.endTime},${trial.aborted}\n`;
    await window.api.appendCSV(file, row);
  }
}