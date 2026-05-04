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
} from "../signal/signalUtils.js";

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

  // Cloud stimulus size (fraction of the shorter half-scene dimension)
  CLOUD_SIZE_MIN: 0.10,   // at stimulusLevel = 0
  CLOUD_SIZE_MAX: 0.45,   // at stimulusLevel = 1

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

  const trials = [];
  let asyncIdx = 0;

  for (let i = 0; i < numTrials; i++) {
    const sync = saSeq[i];
    const iti  = CONFIG.ITI_MIN +
                 Math.round(Math.random() * (CONFIG.ITI_MAX - CONFIG.ITI_MIN));

    const trial = {
      trialIndex:   i + 1,
      synchronous:  sync,
      img:          'cloud',            // CSV field — no image file used
      lr:           lrSeq[i],           // true = left, false = right
      ITI:          iti,                // ms
      slowfast:     null,               // only set for async trials
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
    const scaled = rawValue;

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

    // Create subject directory and trialData.csv header now, before any trial
    this.#initCSVFiles();
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

    // Write frameData header now — so a mid-trial crash still leaves a valid file
    this.#initFrameCSV(trial.trialIndex);

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

    // Write CSVs
    this.#flushFrameCSV(trial);
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
    this.#centerText(ctx, w, h, 'waiting for stream…', 'rgba(255,255,255,0.4)', 18);
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
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '300 20px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Breathe normally…', cx, cy - 80);

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
    this.#centerText(ctx, cx, cy, String(remaining),
      'rgba(255,255,255,0.7)', 52, '200');
  }

  #drawReady(ctx, w, h) {
    this.#centerText(ctx, w / 2, h / 2,
      'Press Space or "Next trial" to begin',
      'rgba(255,255,255,0.35)', 18);
  }

  #drawTrial(ctx, w, h, now) {
    const trial   = this.#trials[this.#trialIndex];
    const tSecs   = (now - this.#trialStartTime) / 1000;

    // Compute stimulus level
    let stimLevel;
    if (trial.synchronous) {
      stimLevel = this.#stimulusLevel;  // updated in #onTrialSample
    } else {
      stimLevel = this.#asyncGen.sample(tSecs);
      this.#stimulusLevel = stimLevel;
    }
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

    // Cloud occupies the correct half of the scene (left or right)
    const halfW  = w / 2;
    const centreX = trial.lr
      ? halfW / 2          // centre of left half
      : halfW + halfW / 2; // centre of right half
    const centreY = h / 2;

    // Size: stimulusLevel [0,1] maps to [MIN_SIZE, MAX_SIZE] in px
    const minSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MIN;
    const maxSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MAX;
    const size    = minSize + stimLevel * (maxSize - minSize);

    this.#drawCloud(ctx, centreX, centreY, size, 1);

    // Subtle dividing line between the two halves
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  #drawITI(ctx, w, h, now) {
    const remaining = Math.max(0,
      this.#itiDuration - (now - this.#itiStartTime));
    const secs = (remaining / 1000).toFixed(1);
    this.#centerText(ctx, w / 2, h / 2,
      `Next trial in ${secs}s`,
      'rgba(255,255,255,0.2)', 16);
  }

  #drawDone(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    this.#centerText(ctx, cx, cy - 40,
      'Experiment complete', 'rgba(255,255,255,0.6)', 24);
    this.#centerText(ctx, cx, cy + 10,
      `${this.#trialData.length} trials recorded`,
      'rgba(255,255,255,0.35)', 16);
    this.#centerText(ctx, cx, cy + 50,
      `Subject: ${this.#subjectCode}`,
      'rgba(255,255,255,0.25)', 14);
  }

  // ── Scene helpers ──────────────────────────────────────────────────────────

  /**
   * Procedural cloud — five overlapping circles with a white-to-light-blue
   * radial gradient. Ported from game.js #drawCloud.
   * size = base radius in px, driven by stimulusLevel.
   */
  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx: 0,           dy: 0,            r: size * 0.55 },
      { dx: -size * 0.42, dy:  size * 0.12, r: size * 0.42 },
      { dx:  size * 0.42, dy:  size * 0.12, r: size * 0.40 },
      { dx: -size * 0.20, dy: -size * 0.28, r: size * 0.34 },
      { dx:  size * 0.22, dy: -size * 0.24, r: size * 0.32 },
    ];

    const grd = ctx.createRadialGradient(
      x, y - size * 0.15, 0,
      x, y, size * 0.8
    );
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(210,230,248,0.88)');

    ctx.beginPath();
    for (const b of blobs) {
      ctx.moveTo(x + b.dx + b.r, y + b.dy);
      ctx.arc(x + b.dx, y + b.dy, b.r, 0, Math.PI * 2);
    }
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  /**
   * Draws centred text. y may be a y-coordinate or h/2 implicitly.
   */
  #centerText(ctx, x, y, text, color, size, weight = '300') {
    ctx.fillStyle    = color;
    ctx.font         = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  // ── CSV output ────────────────────────────────────────────────────────────
  //
  // Two files per subject, written to CONFIG.DATA_DIR/<subjectCode>/:
  //
  //   trialData.csv   — one row per trial (appended after each trial ends)
  //   frameData_N.csv — one row per animation frame for trial N
  //
  // Columns match the MATLAB ibreath_main_v2.m output exactly.
  //
  // Strategy:
  //   • Subject directory + trialData.csv header are created at calibration
  //     start (#initCSVFiles), before any trial runs.
  //   • frameData_N.csv header is written when a trial starts (#initFrameCSV),
  //     so even a crash mid-trial leaves a valid (partial) file.
  //   • Frame rows are buffered in #frameRows during the trial, then flushed
  //     as a single write at trial end (#flushFrameCSV).  This avoids hundreds
  //     of IPC calls per trial while still keeping memory bounded.
  //   • All errors are caught, logged to console, and shown in the HUD
  //     status text so the experimenter is aware immediately.

  // Column headers — must match MATLAB csvColumns exactly
  static #FRAME_HEADER =
    'trialIndex,timestamp,gaze_x,gaze_y,' +
    'breathLevel_input,breathLevel_scaled,stimulusLevel\n';

  static #TRIAL_HEADER =
    'trialIndex,subject,synchronous,img,lr,slowfast,' +
    'ITI,startTime,endTime,aborted\n';

  /** Called at the start of #beginCalibration — creates dir + trialData header. */
  async #initCSVFiles() {
    if (!window.api) {
      console.warn('[CSV] window.api not available — file I/O disabled');
      return;
    }
    const dir = `${CONFIG.DATA_DIR}/${this.#subjectCode}`;

    // Ensure subject directory exists
    const dirResult = await window.api.ensureDir(dir);
    if (!dirResult.ok) {
      this.#csvWarn(`Could not create data dir: ${dirResult.error}`);
      return;
    }

    // Write trialData.csv header (overwrites any previous TEST file)
    const trialFile = `${dir}/trialData.csv`;
    const result = await window.api.writeCSV(trialFile, IBreath.#TRIAL_HEADER);
    if (!result.ok) {
      this.#csvWarn(`Could not init trialData.csv: ${result.error}`);
    } else {
      console.log(`[CSV] initialised ${trialFile}`);
    }
  }

  /** Called at the start of each trial — writes frameData_N.csv header. */
  async #initFrameCSV(trialIndex) {
    if (!window.api) return;
    const file = this.#frameCSVPath(trialIndex);
    const result = await window.api.writeCSV(file, IBreath.#FRAME_HEADER);
    if (!result.ok) {
      this.#csvWarn(`Could not init frameData_${trialIndex}.csv: ${result.error}`);
    }
  }

  /** Called at the end of each trial — flushes buffered frame rows. */
  async #flushFrameCSV(trial) {
    if (!window.api || this.#frameRows.length === 0) return;

    const rows = this.#frameRows.map(r =>
      `${trial.trialIndex},${r.t},` +
      `${r.gaze_x.toFixed(1)},${r.gaze_y.toFixed(1)},` +
      `${r.raw.toFixed(6)},${r.scaled.toFixed(6)},${r.stim.toFixed(6)}`
    ).join('\n') + '\n';

    const result = await window.api.appendCSV(this.#frameCSVPath(trial.trialIndex), rows);
    if (!result.ok) {
      this.#csvWarn(`Could not write frameData_${trial.trialIndex}.csv: ${result.error}`);
    } else {
      console.log(`[CSV] wrote ${this.#frameRows.length} frame rows for trial ${trial.trialIndex}`);
    }
  }

  /** Called at the end of each trial — appends one row to trialData.csv. */
  async #appendTrialDataCSV(trial) {
    if (!window.api) return;

    const row =
      `${trial.trialIndex},` +
      `${this.#subjectCode},` +
      `${trial.synchronous},` +
      `${trial.img},` +
      `${trial.lr},` +
      `${trial.slowfast ?? ''},` +
      `${trial.ITI},` +
      `${trial.startTime ?? ''},` +
      `${trial.endTime   ?? ''},` +
      `${trial.aborted}\n`;

    const result = await window.api.appendCSV(
      `${CONFIG.DATA_DIR}/${this.#subjectCode}/trialData.csv`,
      row
    );
    if (!result.ok) {
      this.#csvWarn(`Could not append to trialData.csv: ${result.error}`);
    }
  }

  /** Convenience: full path for a trial's frameData CSV. */
  #frameCSVPath(trialIndex) {
    return `${CONFIG.DATA_DIR}/${this.#subjectCode}/frameData_${trialIndex}.csv`;
  }

  /** Shows a CSV error in the HUD status text (non-fatal). */
  #csvWarn(msg) {
    console.error('[CSV]', msg);
    if (this.#stateEl) {
      const prev = this.#stateEl.textContent;
      this.#stateEl.textContent = `⚠ CSV: ${msg}`;
      this.#stateEl.style.color = '#e09898';
      // Restore after 5 s so the experimenter sees it but it doesn't persist
      setTimeout(() => {
        this.#stateEl.textContent  = prev;
        this.#stateEl.style.color  = '';
      }, 5000);
    }
  }
}