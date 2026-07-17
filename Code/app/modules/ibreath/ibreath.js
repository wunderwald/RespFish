/**
 * iBreath experiment frontend
 * ============================
 * Port of ibreath_main_v2.m to the RespFish Electron frontend architecture.
 *
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 *
 * State machine:  IDLE → CALIBRATING → READY → TRIAL → [RESPONSE →] ITI → DONE
 *
 * Sub-modules:
 *   config.js      — CONFIG and STATE constants
 *   trialParams.js — makeTrialParams()
 *   hud.js         — LocalHud (embedded experimenter bar)
 *   remoteHud.js   — RemoteHud (IPC-backed, for experimenter window)
 *   renderer.js    — canvas drawing
 *   csv.js         — file output
 */

import { GaussianSmoother, AsyncSignalGenerator, mapRange } from '../signal/signalUtils.js';
import { AutocorrEstimator } from '../signal/breathRateEstimators.js';
import { RespCalibration } from '../calibration/calibration.js';
import { IBreathSound } from './ibreath_sound.js';
import { CONFIG, STATE } from './config.js';
import { makeTrialParams } from './trialParams.js';
import { LocalHud } from './hud.js';
import { IBreathRenderer } from './ibreath_renderer.js';
import { IBreathCSV } from './csv.js';
import { MarkerStream } from '../stream/markerStream.js';
import { EyeLinkControl } from '../stream/eyelinkControl.js';

export { CONFIG };

export default class IBreath {
  // ── state ──────────────────────────────────────────────────────────────
  #state = STATE.IDLE;
  #streamReady = false;
  #respStatusText = 'waiting for stream…';
  #eyelinkReady = false;

  // ── experiment data ────────────────────────────────────────────────────
  #subjectCode = CONFIG.SUBJECT_CODE;
  #group = 'target';
  #trials = [];
  #trialIndex = 0;
  #trialData = [];

  // ── calibration ────────────────────────────────────────────────────────
  #calSamples = [];      // raw samples, fed to AsyncSignalGenerator for freq estimation
  #calibration = null;   // RespCalibration — derives the sync stimulus range
  #calFailed = false;

  // ── signal pipeline ────────────────────────────────────────────────────
  #smoother = new GaussianSmoother(CONFIG.SMOOTH_WINDOW);
  #asyncGen = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });
  #syncStimulusRange = [0.3, 0.4];   // raw native-scale window — used to rescale the live signal into [0,1]
  #syncDisplayRange = [0, 1];        // [0,1]-space window the sync display actually occupied — async's output target

  // ── per-trial state ────────────────────────────────────────────────────
  #trialStartTime = null;
  #stimulusLevel = 0;
  #lastRawSample = 0;
  #lastScaledSample = 0;
  #syncSignal = [];
  #syncStimulusSignal = [];
  #frameRows = [];

  // ── ITI / display ─────────────────────────────────────────────────────
  #itiStartTime = null;
  #itiDuration = 0;
  #displayStartTime = null;

  // ── pause ──────────────────────────────────────────────────────────────
  #pausedFromState = null;
  #pausedStateText = null;
  #pausedAt = 0;

  // ── response (SHOW_QUESTIONS) ──────────────────────────────────────────
  #pendingTrial      = null;
  #responseStartTime = null;

  // ── flash (FLASHING_IMAGE) ─────────────────────────────────────────────
  #flashShown = false;
  #flashStartTime = null;
  #flashEndSent = false;
  #flashActive = false;

  // ── gaze ───────────────────────────────────────────────────────────────
  #gazeX = null;
  #gazeY = null;
  #gazeEnabled = false;

  // ── sub-modules ────────────────────────────────────────────────────────
  #markers = null;
  #eyelinkControl = null;
  #hud = null;
  #renderer = null;
  #csv = null;
  #sound = null;

  constructor({ statsContainer, sceneContainer, hudFactory }) {
    const callbacks = {
      onStart:           (settings) => this.#beginCalibration(settings),
      onNext:            () => this.#advanceTrial(),
      onAbort:           () => this.#abortTrial(),
      onResponse:        (v) => this.#onResponse(v),
      onPause:           () => this.#onPause(),
      onPlay:            () => this.#onPlay(),
      onRecalibrateGaze: () => this.#beginEyeCalibration(),
      onRetryCalibration:      () => this.#retryCalibration(),
      onUseDefaultCalibration: () => this.#useDefaultCalibration(),
    };
    this.#hud = hudFactory
      ? hudFactory(callbacks)
      : new LocalHud(statsContainer, CONFIG.SUBJECT_CODE, callbacks);

    this.#renderer = new IBreathRenderer(sceneContainer);

    this.#markers = CONFIG.SEND_MARKERS
      ? new MarkerStream(CONFIG.MARKER_STREAM_URL)
      : { send() {} };
    this.#eyelinkControl = new EyeLinkControl(CONFIG.EYELINK_CONTROL_URL, {
      onStatus: (status) => this.#onEyelinkStatus(status),
    });
    this.#sound = new IBreathSound();
    this.#sound.init().catch((e) => console.warn('[IBreath] sound init failed:', e));
    this.#bindKeys();
    setInterval(() => this.#update(), 16);
    requestAnimationFrame(() => this.#drawLoop());
  }

  // ── Public interface ───────────────────────────────────────────────────

  pushGazeSample(channels) {
    const wasEnabled = this.#gazeEnabled;
    if (!channels) {
      this.#gazeEnabled = false;
    } else {
      this.#gazeX = channels[0] ?? null;
      this.#gazeY = channels[1] ?? null;
      this.#gazeEnabled = true;
    }
    if (this.#gazeEnabled !== wasEnabled) this.#hud.gazeActive = this.#gazeEnabled;
  }

  pushSample(rawValue) {
    this.#lastRawSample = rawValue;
    this.#lastScaledSample = rawValue;
    this.#smoother.push(rawValue);

    if (this.#state === STATE.CALIBRATING) {
      this.#calSamples.push(rawValue);
      this.#calibration.push(this.#smoother.value);
    } else if (this.#state === STATE.TRIAL) {
      this.#onTrialSample(rawValue);
    }
  }

  setStatus({ type, text }) {
    this.#streamReady = (type === 'connected');
    this.#respStatusText = text;
    this.#updateIdleReadiness();
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────

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
        case 'ArrowLeft':
          if (this.#state === STATE.RESPONSE) this.#onResponse('left');
          break;
        case 'ArrowRight':
          if (this.#state === STATE.RESPONSE) this.#onResponse('right');
          break;
      }
    });
  }

  // ── State machine ──────────────────────────────────────────────────────

  #beginCalibration({ debugGaze, autoAdvance, flashingImage, calibrationSecs, showQuestions } = {}) {
    if (debugGaze       !== undefined) CONFIG.DEBUG_GAZE        = debugGaze;
    if (autoAdvance     !== undefined) CONFIG.AUTO_ADVANCE      = autoAdvance;
    if (flashingImage   !== undefined) CONFIG.FLASHING_IMAGE    = flashingImage;
    if (calibrationSecs !== undefined) CONFIG.CALIBRATION_SECS = calibrationSecs;
    if (showQuestions   !== undefined) CONFIG.SHOW_QUESTIONS    = showQuestions;

    this.#subjectCode = this.#hud.subjectCode;
    this.#group       = this.#hud.group;
    this.#trials = makeTrialParams(CONFIG.MAX_NUM_TRIALS, this.#group);
    this.#trialIndex = 0;
    this.#trialData = [];
    this.#calSamples = [];
    this.#calibration = new RespCalibration({ durationSecs: CONFIG.CALIBRATION_SECS });
    this.#calibration.start();
    this.#calFailed = false;
    this.#smoother.reset();

    this.#state = STATE.CALIBRATING;
    this.#hud.experimentStartedAt = Date.now();
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: CONFIG.CALIBRATION_SECS };
    this.#hud.startEnabled = false;
    this.#hud.inputsLocked = true;
    this.#hud.pauseVisible = false;
    this.#hud.stateText    = 'calibrating…';

    this.#csv = new IBreathCSV(this.#subjectCode, this.#group, this.#gazeEnabled, (msg) => this.#csvWarn(msg));
    this.#csv.init();
    this.#markers.send('calibration_start');
  }

  #finishCalibration() {
    this.#markers.send('calibration_end');

    const result = this.#calibration.finish();
    if (!result) {
      console.warn('[IBreath] calibration produced no samples');
      this.#markers.send('calibration_failed');
      this.#calFailed = true;
      this.#hud.stateText = '⚠ calibration failed — no signal received';
      this.#hud.calFailed = true;
      return;
    }

    this.#completeCalibration([result.min, result.max]);
  }

  #completeCalibration(range) {
    this.#syncStimulusRange = range;

    const sampleRate = this.#calSamples.length / CONFIG.CALIBRATION_SECS;
    this.#asyncGen.calibrate(this.#calSamples, sampleRate, this.#syncDisplayRange);

    this.#hud.trialText = `0 / ${this.#trials.length}`;
    this.#calFailed = false;
    this.#hud.calFailed = false;

    if (CONFIG.AUTO_ADVANCE) {
      this.#advanceTrial();
    } else {
      this.#state = STATE.READY;
      this.#hud.stateTimer   = { startedAt: Date.now(), duration: null };
      this.#hud.pauseVisible = false;
      this.#hud.stateText    = 'ready — press Space or Next trial to begin';
      this.#hud.nextVisible  = true;
    }
  }

  #retryCalibration() {
    if (this.#state !== STATE.CALIBRATING || !this.#calFailed) return;
    this.#calSamples = [];
    this.#calibration.start();
    this.#calFailed = false;
    this.#hud.calFailed = false;
    this.#hud.stateTimer = { startedAt: Date.now(), duration: CONFIG.CALIBRATION_SECS };
    this.#hud.stateText  = 'calibrating…';
    this.#markers.send('calibration_start');
  }

  #useDefaultCalibration() {
    if (this.#state !== STATE.CALIBRATING || !this.#calFailed) return;
    this.#markers.send('calibration_default_used');
    this.#completeCalibration(CONFIG.DEFAULT_CAL_RANGE);
  }

  #advanceTrial() {
    if (this.#trialIndex >= this.#trials.length) {
      this.#endExperiment();
      return;
    }

    const trial = this.#trials[this.#trialIndex];

    if (!trial.synchronous) {
      const factor = trial.slowfast
        ? CONFIG.SPEED_FACTOR_SLOW
        : CONFIG.SPEED_FACTOR_FAST;
      this.#asyncGen.setSpeedFactor(factor);

      if (CONFIG.MAP_ASYNC_RANGE_TO_SYNC_RANGE) {
        this.#asyncGen.calibrate(
          new Float32Array(this.#calSamples),
          this.#calSamples.length / CONFIG.CALIBRATION_SECS,
          this.#syncDisplayRange
        );
      }
    }

    this.#syncSignal = [];
    this.#syncStimulusSignal = [];
    this.#frameRows = [];
    this.#stimulusLevel = 0;
    this.#flashShown = false;
    this.#flashStartTime = null;
    this.#flashEndSent = false;
    this.#smoother.reset();

    // Pre-fill smoother with 64 samples (matching MATLAB pre-buffer)
    for (let i = 0; i < CONFIG.SMOOTH_WINDOW; i++) {
      this.#smoother.push(this.#lastScaledSample);
    }
    if (trial.synchronous) {
      for (let i = 0; i < CONFIG.SMOOTH_WINDOW; i++) {
        this.#syncSignal.push(this.#lastScaledSample);
      }
    }

    this.#hud.nextVisible  = false;
    this.#hud.abortVisible = false;
    this.#hud.pauseVisible = true;

    if (CONFIG.ANIMATION_DISPLAY) {
      this.#displayStartTime = performance.now();
      this.#state = STATE.DISPLAY;
      this.#sound.startDisplay();
      this.#hud.stateTimer = { startedAt: Date.now(), duration: CONFIG.DISPLAY_SECS };
      this.#markers.send(`display_start_t${trial.trialIndex}`);
    } else {
      this.#beginTrial();
    }
    const flashNote = CONFIG.FLASHING_IMAGE
      ? (trial.flashImage ? `  ·  flash @ ${trial.flashTime}s` : '  ·  no flash')
      : '';
    this.#hud.stateText = (trial.synchronous ? 'sync trial' : 'async trial') + flashNote;
    this.#hud.trialText = `${this.#trialIndex + 1} / ${this.#trials.length}`;
  }

  #beginTrial() {
    const trial = this.#trials[this.#trialIndex];
    this.#trialStartTime = performance.now();
    trial.startTime = new Date().toISOString();
    this.#csv.initFrameCSV(trial.trialIndex);
    this.#state = STATE.TRIAL;
    this.#sound.stopDisplay();
    this.#sound.startTrial();
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: CONFIG.MAX_TRIAL_TIME };
    this.#hud.abortVisible = true;
    this.#markers.send(`trial_start_t${trial.trialIndex}`);
  }

  #onTrialSample(rawValue) {
    const trial = this.#trials[this.#trialIndex];
    if (trial.synchronous) {
      this.#syncSignal.push(rawValue);
      const smoothedRaw = this.#smoother.value;
      this.#syncStimulusSignal.push(smoothedRaw);
      this.#stimulusLevel = Math.max(0, Math.min(1,
        mapRange(smoothedRaw, this.#syncStimulusRange, [0, 1])
      ));
    }
  }

  #endTrial(aborted = false) {
    const trial = this.#trials[this.#trialIndex];
    trial.endTime = new Date().toISOString();
    trial.aborted = aborted;

    if (trial.synchronous && this.#syncSignal.length > CONFIG.SMOOTH_WINDOW) {
      // Strip the 64-sample pre-buffer (matches syncSignal(65:end) in MATLAB)
      const cleanSignal = new Float32Array(
        this.#syncSignal.slice(CONFIG.SMOOTH_WINDOW)
      );
      const sampleRate = cleanSignal.length /
        ((performance.now() - this.#trialStartTime) / 1000);

      const rawLvls = this.#syncStimulusSignal;
      const rawMin = Math.min(...rawLvls), rawMax = Math.max(...rawLvls);
      this.#syncDisplayRange = [
        Math.max(0, Math.min(1, mapRange(rawMin, this.#syncStimulusRange, [0, 1]))),
        Math.max(0, Math.min(1, mapRange(rawMax, this.#syncStimulusRange, [0, 1]))),
      ];

      this.#asyncGen.calibrate(cleanSignal, sampleRate, this.#syncDisplayRange);

      this.#syncStimulusRange = [rawMin, rawMax];
    }

    trial.flashShown = this.#flashShown;
    this.#sound.stopTrial();
    this.#csv.flushFrameCSV(trial, this.#frameRows);
    this.#markers.send(aborted ? `trial_abort_t${trial.trialIndex}` : `trial_end_t${trial.trialIndex}`);
    this.#hud.abortVisible = false;
    this.#trialIndex++;

    if (CONFIG.SHOW_QUESTIONS && !aborted) {
      this.#pendingTrial      = trial;
      this.#responseStartTime = performance.now();
      this.#state             = STATE.RESPONSE;
      this.#hud.stateTimer    = { startedAt: Date.now(), duration: CONFIG.RESPONSE_TIMEOUT_SECS };
      this.#hud.stateText     = 'respond…';
      this.#markers.send(`response_start_t${trial.trialIndex}`);
    } else {
      this.#csv.appendTrialData(trial);
      this.#trialData.push({ ...trial });
      this.#startITIorEnd(trial);
    }
  }

  #onResponse(side) {
    if (!this.#pendingTrial) return;
    const trial = this.#pendingTrial;
    this.#pendingTrial = null;

    let response;
    if (side === 'timeout') {
      response = 'timeout';
    } else if (trial.questionType === 'lr') {
      response = side === 'left' ? 'left' : 'right';
    } else if (trial.questionType === 'img') {
      response = side === 'left' ? 'pufferfish' : 'starfish';
    } else {
      response = side === 'left' ? 'yes' : 'no';
    }
    trial.response = response;

    this.#markers.send(`response_${response}_t${trial.trialIndex}`);
    this.#csv.appendTrialData(trial);
    this.#trialData.push({ ...trial });
    this.#startITIorEnd(trial);
  }

  #startITIorEnd(trial) {
    if (this.#trialIndex >= this.#trials.length) {
      this.#endExperiment();
      return;
    }
    this.#itiStartTime = performance.now();
    this.#itiDuration = trial.ITI;
    this.#state = STATE.ITI;
    this.#hud.stateTimer = { startedAt: Date.now(), duration: trial.ITI / 1000 };
    this.#markers.send(`iti_start_t${trial.trialIndex}`);
    this.#hud.stateText = 'inter-trial interval…';
  }

  #abortTrial() {
    this.#endTrial(true);
  }

  #onPause() {
    const pauseable = [STATE.DISPLAY, STATE.TRIAL, STATE.RESPONSE, STATE.ITI];
    if (!pauseable.includes(this.#state)) return;

    if (this.#state === STATE.TRIAL) {
      // Abort and flush the running trial before pausing
      this.#endTrial(true);
      if (this.#state === STATE.DONE) return;  // last trial just finished — don't pause
      // state is now ITI; resume will skip it and go straight to the next display
      this.#pausedFromState = STATE.ITI;
    } else {
      this.#pausedFromState = this.#state;
    }

    if (this.#pausedFromState === STATE.DISPLAY) this.#sound.stopDisplay();

    this.#pausedStateText = this.#hud.stateText;
    this.#pausedAt        = performance.now();
    this.#state           = STATE.PAUSED;

    this.#markers.send('experiment_pause');

    this.#hud.abortVisible = false;
    this.#hud.pauseVisible = false;
    this.#hud.playVisible  = true;
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: null };
    this.#hud.stateText    = 'paused';
  }

  #onPlay() {
    if (this.#state !== STATE.PAUSED) return;
    const from      = this.#pausedFromState;
    const stateText = this.#pausedStateText;
    this.#pausedFromState = null;
    this.#pausedStateText = null;
    this.#markers.send('experiment_resume');

    switch (from) {
      case STATE.DISPLAY:
        // Rewind animation to the beginning and restart jingle
        this.#displayStartTime = performance.now();
        this.#sound.startDisplay();
        this.#state = STATE.DISPLAY;
        this.#hud.stateTimer   = { startedAt: Date.now(), duration: CONFIG.DISPLAY_SECS };
        this.#hud.pauseVisible = true;
        this.#hud.playVisible  = false;
        this.#hud.stateText    = stateText;
        break;

      case STATE.TRIAL: {
        // Extend the trial clock by however long we were paused
        this.#trialStartTime += performance.now() - this.#pausedAt;
        this.#state = STATE.TRIAL;
        const remaining = CONFIG.MAX_TRIAL_TIME - (performance.now() - this.#trialStartTime) / 1000;
        this.#hud.stateTimer   = { startedAt: Date.now(), duration: Math.max(0, remaining) };
        this.#hud.abortVisible = true;
        this.#hud.pauseVisible = true;
        this.#hud.playVisible  = false;
        this.#hud.stateText    = stateText;
        break;
      }

      case STATE.RESPONSE:
        // Restart the response timeout from zero
        this.#responseStartTime = performance.now();
        this.#state = STATE.RESPONSE;
        this.#hud.stateTimer   = { startedAt: Date.now(), duration: CONFIG.RESPONSE_TIMEOUT_SECS };
        this.#hud.pauseVisible = true;
        this.#hud.playVisible  = false;
        this.#hud.stateText    = stateText;
        break;

      case STATE.ITI:
        // Skip remaining ITI — advance straight to the display animation
        this.#advanceTrial();   // sets pauseVisible, stateText, stateTimer
        this.#hud.playVisible = false;
        break;
    }
  }

  // ── Eye tracker recalibration ──────────────────────────────────────────

  #updateIdleReadiness() {
    if (this.#state !== STATE.IDLE) return;
    const ready = this.#streamReady && this.#eyelinkReady;
    this.#hud.startEnabled = ready;
    this.#hud.stateText = !this.#streamReady
      ? this.#respStatusText
      : !this.#eyelinkReady
        ? 'waiting for eye tracker calibration…'
        : 'stream ready';
  }

  #onEyelinkStatus(status) {
    if (status.state === 'calibrated' || status.state === 'recording') {
      this.#eyelinkReady = true;
    }
    this.#updateIdleReadiness();

    if (this.#state === STATE.EYETRACK_CAL && status.state === 'recording') {
      this.#finishEyeCalibration();
    }
  }

  #beginEyeCalibration() {
    const blocked = [STATE.IDLE, STATE.CALIBRATING, STATE.DONE, STATE.EYETRACK_CAL];
    if (blocked.includes(this.#state)) return;

    if (this.#state === STATE.TRIAL) {
      this.#abortTrial();               // flushes + marks the running trial aborted
    } else if (this.#state === STATE.DISPLAY) {
      this.#sound.stopDisplay();
    } else if (this.#state === STATE.RESPONSE) {
      this.#onResponse('timeout');      // records the pending response, flushes trial data
    }
    // ITI / READY / PAUSED: nothing pending to clean up.
    this.#pausedFromState = null;

    this.#state = STATE.EYETRACK_CAL;
    this.#hud.stateTimer      = { startedAt: Date.now(), duration: null };
    this.#hud.nextVisible     = false;
    this.#hud.abortVisible    = false;
    this.#hud.pauseVisible    = false;
    this.#hud.playVisible     = false;
    this.#hud.gazeCalibrating = true;
    this.#hud.stateText       = 'recalibrating eye tracker — please wait…';

    this.#markers.send('gaze_recalibration_start');
    window.api.window.minimize();
    this.#eyelinkControl.calibrate();
  }

  #finishEyeCalibration() {
    this.#markers.send('gaze_recalibration_end');
    this.#hud.gazeCalibrating = false;
    window.api.window.restore();

    if (this.#trialIndex >= this.#trials.length) {
      this.#endExperiment();
      return;
    }
    this.#state             = STATE.READY;
    this.#hud.stateTimer    = { startedAt: Date.now(), duration: null };
    this.#hud.pauseVisible  = false;
    this.#hud.stateText     = 'ready — press Space or Next trial to begin';
    this.#hud.nextVisible   = true;
  }

  #endExperiment() {
    this.#markers.send('experiment_done');
    this.#state = STATE.DONE;
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: null };
    this.#hud.nextVisible  = false;
    this.#hud.abortVisible = false;
    this.#hud.pauseVisible = false;
    this.#hud.stateText    = 'experiment complete';
    this.#hud.trialText    = `${this.#trials.length} / ${this.#trials.length}`;
  }

  // ── Update loop (setInterval, continues when window loses focus) ──────

  #update() {
    const now = performance.now();

    if (this.#state === STATE.CALIBRATING && !this.#calFailed) {
      if (this.#calibration.isDone) {
        this.#finishCalibration();
      }
    }

    if (this.#state === STATE.DISPLAY) {
      if (now - this.#displayStartTime >= CONFIG.DISPLAY_SECS * 1000) {
        this.#beginTrial();
      }
    }

    if (this.#state === STATE.RESPONSE) {
      if (now - this.#responseStartTime >= CONFIG.RESPONSE_TIMEOUT_SECS * 1000) {
        this.#onResponse('timeout');
      }
    }

    if (this.#state === STATE.ITI) {
      if (now - this.#itiStartTime >= this.#itiDuration) {
        if (CONFIG.AUTO_ADVANCE) {
          this.#advanceTrial();
        } else {
          this.#state = STATE.READY;
          this.#hud.stateTimer  = { startedAt: Date.now(), duration: null };
          this.#hud.nextVisible = true;
          this.#hud.stateText   = 'ready — press Space or Next trial';
        }
      }
    }

    if (this.#state === STATE.TRIAL) {
      const trial = this.#trials[this.#trialIndex];
      const tSecs = (now - this.#trialStartTime) / 1000;

      if (!trial.synchronous) {
        this.#stimulusLevel = this.#asyncGen.sample(tSecs);
      }
      const stimLevel = Math.max(0, Math.min(1, this.#stimulusLevel));
      this.#sound.setNoiseLevel(stimLevel);

      if (CONFIG.FLASHING_IMAGE && trial.flashImage && !this.#flashShown && tSecs >= trial.flashTime) {
        this.#flashShown = true;
        this.#flashStartTime = now;
        this.#markers.send(`flash_start_t${trial.trialIndex}`);
      }
      this.#flashActive = this.#flashShown && (now - this.#flashStartTime < CONFIG.FLASH_DURATION);
      if (CONFIG.FLASHING_IMAGE && this.#flashShown && !this.#flashActive && !this.#flashEndSent) {
        this.#flashEndSent = true;
        this.#markers.send(`flash_end_t${trial.trialIndex}`);
      }

      this.#frameRows.push({
        t: new Date().toISOString(),
        raw: this.#lastRawSample,
        scaled: this.#lastScaledSample,
        stim: stimLevel,
        flash: this.#flashActive ? 1 : 0,
        ...(this.#gazeEnabled ? { gazeX: this.#gazeX ?? '', gazeY: this.#gazeY ?? '' } : {}),
      });

      if (tSecs >= CONFIG.MAX_TRIAL_TIME) {
        this.#endTrial(false);
      }
    }
  }

  // ── Draw loop (requestAnimationFrame, may pause when window loses focus)

  #drawLoop() {
    const now = performance.now();
    const inTrial = this.#state === STATE.TRIAL;
    const trialDrawData = inTrial ? {
      trial:       this.#trials[this.#trialIndex],
      stimLevel:   Math.max(0, Math.min(1, this.#stimulusLevel)),
      flashActive: this.#flashActive,
    } : null;

    try {
      this.#renderer.draw(this.#state, now, {
        calProgress:       this.#calibration?.progress ?? 0,
        calRemaining:      Math.ceil(this.#calibration?.remainingSecs ?? CONFIG.CALIBRATION_SECS),
        itiStartTime:      this.#itiStartTime,
        itiDuration:       this.#itiDuration,
        displayElapsed:    this.#displayStartTime != null ? (now - this.#displayStartTime) / 1000 : 0,
        responseStartTime: this.#responseStartTime,
        questionType:      this.#pendingTrial?.questionType ?? '',
        trialCount:        this.#trialData.length,
        subjectCode:       this.#subjectCode,
        gazeX:             this.#gazeX,
        gazeY:             this.#gazeY,
        ...(trialDrawData ?? {}),
      });
    } catch (e) {
      console.error('[IBreath] draw error:', e);
    }

    requestAnimationFrame(() => this.#drawLoop());
  }

  // ── CSV error display ──────────────────────────────────────────────────

  #csvWarn(msg) {
    if (!this.#hud) return;
    const prev = this.#hud.stateText;
    this.#hud.stateText  = `⚠ CSV: ${msg}`;
    this.#hud.stateColor = '#e09898';
    setTimeout(() => {
      this.#hud.stateText  = prev;
      this.#hud.stateColor = '';
    }, 5000);
  }
}
