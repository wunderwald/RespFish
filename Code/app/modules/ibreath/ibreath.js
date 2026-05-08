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

import {
  GaussianSmoother,
  AutocorrEstimator,
  AsyncSignalGenerator,
} from '../signal/signalUtils.js';
import { CONFIG, STATE } from './config.js';
import { makeTrialParams } from './trialParams.js';
import { LocalHud } from './hud.js';
import { IBreathRenderer } from './ibreath_renderer.js';
import { IBreathCSV } from './csv.js';
import { MarkerStream } from '../stream/markerStream.js';

export { CONFIG };

export default class IBreath {
  // ── state ──────────────────────────────────────────────────────────────
  #state = STATE.IDLE;
  #streamReady = false;

  // ── experiment data ────────────────────────────────────────────────────
  #subjectCode = CONFIG.SUBJECT_CODE;
  #questionType = 'intero';
  #trials = [];
  #trialIndex = 0;
  #trialData = [];

  // ── calibration ────────────────────────────────────────────────────────
  #calStartTime = null;
  #calSamples = [];
  #calStimulusLevels = [];

  // ── signal pipeline ────────────────────────────────────────────────────
  #smoother = new GaussianSmoother(CONFIG.SMOOTH_WINDOW);
  #asyncGen = new AsyncSignalGenerator({ estimator: new AutocorrEstimator() });
  #syncStimulusRange = [0.3, 0.4];

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
  #hud = null;
  #renderer = null;
  #csv = null;

  constructor({ statsContainer, sceneContainer, hudFactory }) {
    const callbacks = {
      onStart:    (settings) => this.#beginCalibration(settings),
      onNext:     () => this.#advanceTrial(),
      onAbort:    () => this.#abortTrial(),
      onResponse: (v) => this.#onResponse(v),
    };
    this.#hud = hudFactory
      ? hudFactory(callbacks)
      : new LocalHud(statsContainer, CONFIG.SUBJECT_CODE, callbacks);

    this.#renderer = new IBreathRenderer(sceneContainer);

    this.#markers = CONFIG.SEND_MARKERS
      ? new MarkerStream(CONFIG.MARKER_STREAM_URL)
      : { send() {} };
    this.#bindKeys();
    setInterval(() => this.#update(), 16);
    requestAnimationFrame(() => this.#drawLoop());
  }

  // ── Public interface ───────────────────────────────────────────────────

  pushGazeSample(channels) {
    if (!channels) {
      this.#gazeEnabled = false;
      return;
    }
    this.#gazeX = channels[0] ?? null;
    this.#gazeY = channels[1] ?? null;
    this.#gazeEnabled = true;
  }

  pushSample(rawValue) {
    this.#lastRawSample = rawValue;
    this.#lastScaledSample = rawValue;
    this.#smoother.push(rawValue);

    if (this.#state === STATE.CALIBRATING) {
      this.#calSamples.push(rawValue);
      this.#calStimulusLevels.push(this.#smoother.value);
    } else if (this.#state === STATE.TRIAL) {
      this.#onTrialSample(rawValue);
    }
  }

  setStatus({ type, text }) {
    this.#streamReady = (type === 'connected');
    if (this.#state === STATE.IDLE) {
      this.#hud.stateText    = this.#streamReady ? 'stream ready' : text;
      this.#hud.startEnabled = this.#streamReady;
    }
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
          if (this.#state === STATE.RESPONSE) this.#onResponse(true);
          break;
        case 'ArrowRight':
          if (this.#state === STATE.RESPONSE) this.#onResponse(false);
          break;
      }
    });
  }

  // ── State machine ──────────────────────────────────────────────────────

  #beginCalibration({ debugGaze, autoAdvance, flashingImage, calibrationSecs } = {}) {
    if (debugGaze       !== undefined) CONFIG.DEBUG_GAZE        = debugGaze;
    if (autoAdvance     !== undefined) CONFIG.AUTO_ADVANCE      = autoAdvance;
    if (flashingImage   !== undefined) CONFIG.FLASHING_IMAGE    = flashingImage;
    if (calibrationSecs !== undefined) CONFIG.CALIBRATION_SECS = calibrationSecs;

    this.#subjectCode = this.#hud.subjectCode;
    this.#questionType = this.#hud.questionType;
    this.#trials = makeTrialParams(CONFIG.MAX_NUM_TRIALS);
    this.#trialIndex = 0;
    this.#trialData = [];
    this.#calSamples = [];
    this.#calStimulusLevels = [];
    this.#calStartTime = performance.now();
    this.#smoother.reset();

    this.#state = STATE.CALIBRATING;
    this.#hud.experimentStartedAt = Date.now();
    this.#hud.stateTimer  = { startedAt: Date.now(), duration: CONFIG.CALIBRATION_SECS };
    this.#hud.startEnabled = false;
    this.#hud.inputsLocked = true;
    this.#hud.stateText = 'calibrating…';

    this.#csv = new IBreathCSV(this.#subjectCode, this.#questionType, this.#gazeEnabled, (msg) => this.#csvWarn(msg));
    this.#csv.init();
    this.#markers.send('calibration_start');
  }

  #finishCalibration() {
    this.#markers.send('calibration_end');
    const sampleRate = this.#calSamples.length / CONFIG.CALIBRATION_SECS;
    this.#asyncGen.calibrate(this.#calSamples, sampleRate, null);

    const lvls = this.#calStimulusLevels;
    this.#syncStimulusRange = [Math.min(...lvls) * 0.8, Math.max(...lvls) * 0.8];

    this.#hud.trialText = `0 / ${this.#trials.length}`;

    if (CONFIG.AUTO_ADVANCE) {
      this.#advanceTrial();
    } else {
      this.#state = STATE.READY;
      this.#hud.stateTimer  = { startedAt: Date.now(), duration: null };
      this.#hud.stateText   = 'ready — press Space or Next trial to begin';
      this.#hud.nextVisible = true;
    }
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
          this.#syncStimulusRange
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

    if (CONFIG.ANIMATION_DISPLAY) {
      this.#displayStartTime = performance.now();
      this.#state = STATE.DISPLAY;
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
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: CONFIG.MAX_TRIAL_TIME };
    this.#hud.abortVisible = true;
    this.#markers.send(`trial_start_t${trial.trialIndex}`);
  }

  #onTrialSample(scaled) {
    const trial = this.#trials[this.#trialIndex];
    if (trial.synchronous) {
      this.#syncSignal.push(scaled);
      this.#stimulusLevel = this.#smoother.value;
      this.#syncStimulusSignal.push(this.#stimulusLevel);
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
      this.#asyncGen.calibrate(cleanSignal, sampleRate, this.#syncStimulusRange);

      const lvls = this.#syncStimulusSignal;
      this.#syncStimulusRange = [Math.min(...lvls), Math.max(...lvls)];
    }

    trial.flashShown = this.#flashShown;
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

  #onResponse(sync) {
    if (!this.#pendingTrial) return;
    const trial = this.#pendingTrial;
    this.#pendingTrial = null;
    trial.response = sync;

    const respMarker = sync === true ? 'yes' : sync === false ? 'no' : 'timeout';
    this.#markers.send(`response_${respMarker}_t${trial.trialIndex}`);
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

  #endExperiment() {
    this.#markers.send('experiment_done');
    this.#state = STATE.DONE;
    this.#hud.stateTimer   = { startedAt: Date.now(), duration: null };
    this.#hud.nextVisible  = false;
    this.#hud.abortVisible = false;
    this.#hud.stateText    = 'experiment complete';
    this.#hud.trialText    = `${this.#trials.length} / ${this.#trials.length}`;
  }

  // ── Update loop (setInterval, continues when window loses focus) ──────

  #update() {
    const now = performance.now();

    if (this.#state === STATE.CALIBRATING) {
      if (now - this.#calStartTime >= CONFIG.CALIBRATION_SECS * 1000) {
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
        calStartTime:      this.#calStartTime,
        itiStartTime:      this.#itiStartTime,
        itiDuration:       this.#itiDuration,
        displayElapsed:    this.#displayStartTime != null ? (now - this.#displayStartTime) / 1000 : 0,
        responseStartTime: this.#responseStartTime,
        questionType:      this.#questionType,
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
