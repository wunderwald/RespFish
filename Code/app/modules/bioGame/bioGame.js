/**
 * bioGame.js — Biofeedback breath-control game
 * =============================================
 * A puffer fish swims in an underwater world. The player controls vertical
 * position via their breath signal (exhale → fish up & grows; inhale → down &
 * shrinks). Starfishes appear along a sinusoidal target-breath curve; the
 * player must breathe in sync to collect them.
 *
 * State machine:  IDLE → CALIBRATING → READY → COUNTDOWN → PLAYING
 *                                                 ↑              ↓
 *                                          INTERMISSION ← (block 1 end)
 *                                                 ↓
 *                                           COUNTDOWN → PLAYING → DONE
 *
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 */

import { GaussianSmoother } from '../signal/signalUtils.js';
import { MarkerStream }     from '../stream/markerStream.js';
import { CONFIG, STATE }    from './bioGame_config.js';
import { BioGameRenderer }  from './bioGame_renderer.js';
import { BioGameCSV }       from './bioGame_csv.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function randBetween(lo, hi) { return lo + Math.random() * (hi - lo); }

function targetCurveY(t, bpm) {
  return 0.5 + 0.45 * Math.sin(2 * Math.PI * (t / (60 / bpm)));
}

// ── BioGame ───────────────────────────────────────────────────────────────────

export default class BioGame {
  // ── State ─────────────────────────────────────────────────────────────────
  #state        = STATE.IDLE;
  #streamReady  = false;
  #inputsLocked = false;

  // ── Experiment data ───────────────────────────────────────────────────────
  #subjectCode  = CONFIG.SUBJECT_CODE;
  #group        = CONFIG.GROUP;
  #naturalBpm   = CONFIG.NATURAL_BPM;
  #showCurve    = CONFIG.SHOW_CURVE;
  #dataDir      = CONFIG.DATA_DIR;

  // ── Block management ──────────────────────────────────────────────────────
  #blockIndex       = 0;
  #blockStartTime   = null;   // performance.now() when block started
  #scoreBlock       = [0, 0]; // score for each block

  // ── Signal processing ─────────────────────────────────────────────────────
  #smoother         = new GaussianSmoother(CONFIG.SMOOTH_WINDOW);
  #lastRaw          = 0;
  #calSamples       = [];     // smoothed values collected during calibration
  #calStartTime     = null;
  #normRange        = [0, 1]; // [min, max] of calibrated smoothed signal

  // ── Fish state ────────────────────────────────────────────────────────────
  #fishNormY    = 0.5;    // normalised fish Y (0 = bottom, 1 = top)
  #prevFishNormY = 0.5;
  #fishTilt     = 0;      // current tilt in radians

  // ── Starfishes ────────────────────────────────────────────────────────────
  #starfishes       = [];
  #nextSpawnTime    = 0;  // performance.now() of next spawn

  // ── Countdown ────────────────────────────────────────────────────────────
  #countdownStartTime = null;

  // ── Background scroll ────────────────────────────────────────────────────
  #bgScrollX    = 0;      // total scroll in canvas-widths

  // ── Data / frame recording ───────────────────────────────────────────────
  #csv              = null;
  #lastFrameRecord  = 0;

  // ── Timing ────────────────────────────────────────────────────────────────
  #lastRafTime  = null;

  // ── Sub-modules ───────────────────────────────────────────────────────────
  #markers  = null;
  #renderer = null;

  constructor({ sceneContainer }) {
    this.#renderer = new BioGameRenderer(sceneContainer);

    this.#markers = CONFIG.SEND_MARKERS
      ? new MarkerStream(CONFIG.MARKER_STREAM_URL)
      : { send() {} };

    window.api.frontend.onAction((action) => this.#onAction(action));

    // State machine tick — runs even when window loses focus
    setInterval(() => this.#tick(), 16);

    // Render loop
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // ── Public interface ──────────────────────────────────────────────────────

  pushSample(rawValue) {
    this.#lastRaw = rawValue;
    this.#smoother.push(rawValue);

    if (this.#state === STATE.CALIBRATING) {
      this.#calSamples.push(this.#smoother.value);
    }
  }

  setStatus({ type, text }) {
    this.#streamReady = (type === 'connected');
    if (this.#state === STATE.IDLE) {
      this.#pushState({ stateText: this.#streamReady ? 'stream ready' : (text ?? 'no stream'), startEnabled: this.#streamReady });
    }
  }

  // ── Action handler (from experimenter window) ─────────────────────────────

  #onAction({ type, subjectCode, group, naturalBpm, showCurve, dataDir }) {
    switch (type) {
      case 'start':
        if (subjectCode !== undefined) this.#subjectCode = subjectCode;
        if (group       !== undefined) { this.#group = group; CONFIG.GROUP = group; }
        if (naturalBpm  !== undefined) { this.#naturalBpm = naturalBpm; CONFIG.NATURAL_BPM = naturalBpm; }
        if (showCurve   !== undefined) { this.#showCurve  = showCurve;  CONFIG.SHOW_CURVE  = showCurve; }
        if (dataDir     !== undefined) { this.#dataDir    = dataDir;    CONFIG.DATA_DIR    = dataDir; }
        if (this.#state === STATE.IDLE && this.#streamReady) this.#beginCalibration();
        break;

      case 'next':
        if (this.#state === STATE.INTERMISSION) this.#startCountdown();
        else if (this.#state === STATE.READY)   this.#startCountdown();
        break;

      case 'abort':
        if (this.#state === STATE.PLAYING) this.#endBlock(true);
        break;

      case 'ready':
        this.#pushState();
        break;
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────

  #beginCalibration() {
    this.#calSamples  = [];
    this.#calStartTime = performance.now();
    this.#smoother.reset();
    this.#inputsLocked = true;
    this.#blockIndex   = 0;
    this.#scoreBlock   = [0, 0];

    this.#csv = new BioGameCSV(this.#subjectCode, this.#group, (msg) => this.#csvWarn(msg));
    this.#csv.init();

    this.#setState(STATE.CALIBRATING);
    this.#markers.send('calibration_start');
    this.#pushState({ stateText: 'calibrating…', abortVisible: false, inputsLocked: true });
  }

  #finishCalibration() {
    this.#markers.send('calibration_end');
    const lvls = this.#calSamples;
    // Same approach as iBreath: scale range by 0.8 to give headroom
    this.#normRange = [Math.min(...lvls) * 0.8, Math.max(...lvls) * 0.8];
    console.log(`[BioGame] norm range: [${this.#normRange[0].toFixed(3)}, ${this.#normRange[1].toFixed(3)}]`);

    this.#setState(STATE.READY);
    this.#pushState({ stateText: 'ready — press Space or Start', nextVisible: true });
  }

  #startCountdown() {
    this.#countdownStartTime = performance.now();
    this.#setState(STATE.COUNTDOWN);
    this.#markers.send(`countdown_start_block${this.#blockIndex}`);
    this.#pushState({ stateText: 'starting…', nextVisible: false });
  }

  #startBlock() {
    this.#blockStartTime  = performance.now();
    this.#lastFrameRecord = performance.now();
    this.#starfishes      = [];
    this.#nextSpawnTime   = performance.now() + randBetween(CONFIG.STARFISH_SPAWN_MIN_MS, CONFIG.STARFISH_SPAWN_MAX_MS);

    this.#csv.initBlockCSV(this.#blockIndex);

    this.#setState(STATE.PLAYING);
    this.#markers.send(`block_start_${this.#blockIndex}`);
    this.#pushState({ stateText: `block ${this.#blockIndex + 1} / ${CONFIG.NUM_BLOCKS}`, abortVisible: true });
  }

  #endBlock(aborted = false) {
    this.#csv.flushFrames(this.#blockIndex);
    this.#markers.send(aborted
      ? `block_abort_${this.#blockIndex}`
      : `block_end_${this.#blockIndex}`);
    this.#csv.appendEvent(this.#blockIndex, aborted ? 'block_abort' : 'block_end',
      this.#scoreBlock[this.#blockIndex]);

    if (aborted || this.#blockIndex >= CONFIG.NUM_BLOCKS - 1) {
      this.#endExperiment();
      return;
    }

    this.#blockIndex++;
    this.#setState(STATE.INTERMISSION);
    this.#pushState({
      stateText:   'intermission',
      score:       this.#scoreBlock[0],
      abortVisible: false,
      nextVisible:  true,
    });
  }

  #endExperiment() {
    this.#setState(STATE.DONE);
    this.#markers.send('experiment_done');
    const total = this.#scoreBlock[0] + this.#scoreBlock[1];
    this.#pushState({ stateText: 'done', abortVisible: false, nextVisible: false, score: total });
  }

  // ── Update loop (setInterval — continues when window is unfocused) ────────

  #tick() {
    const now = performance.now();

    if (this.#state === STATE.CALIBRATING) {
      if (now - this.#calStartTime >= CONFIG.CALIBRATION_SECS * 1000) {
        this.#finishCalibration();
      }
    }

    if (this.#state === STATE.COUNTDOWN) {
      const elapsed = (now - this.#countdownStartTime) / 1000;
      if (elapsed >= CONFIG.COUNTDOWN_SECS) {
        this.#startBlock();
      }
    }

    if (this.#state === STATE.PLAYING) {
      const blockElapsed = (now - this.#blockStartTime) / 1000;
      if (blockElapsed >= CONFIG.BLOCK_DURATION_SECS) {
        this.#endBlock(false);
      }
    }
  }

  // ── RAF loop — game updates + rendering ───────────────────────────────────

  #rafLoop(now) {
    const dt = this.#lastRafTime != null ? clamp((now - this.#lastRafTime) / 1000, 0, 0.05) : 0;
    this.#lastRafTime = now;

    if (this.#state === STATE.PLAYING || this.#state === STATE.CALIBRATING) {
      this.#updateSignal(dt);
    }

    if (this.#state === STATE.PLAYING) {
      this.#bgScrollX += CONFIG.BG_SCROLL_SPEED * dt;
      this.#updateStarfishes(now, dt);
      this.#recordFrame(now);
    }

    this.#renderer.draw(this.#buildRenderData(now, dt));
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // ── Signal normalization ──────────────────────────────────────────────────

  #updateSignal(dt) {
    const [rMin, rMax] = this.#normRange;
    const range = rMax - rMin || 1e-6;
    const norm  = clamp((this.#smoother.value - rMin) / range, 0, 1);

    this.#prevFishNormY = this.#fishNormY;
    this.#fishNormY     = norm;

    // Smooth tilt: nose-up when moving up, nose-down when moving down
    const vel   = dt > 0 ? (norm - this.#prevFishNormY) / dt : 0;
    const tgt   = clamp(-vel * 1.8, -Math.PI / 6, Math.PI / 6);
    const tau   = 0.18;
    this.#fishTilt = lerp(this.#fishTilt, tgt, 1 - Math.exp(-dt / tau));
  }

  // ── Starfish spawning and movement ────────────────────────────────────────

  #updateStarfishes(now, dt) {
    const blockTime = (now - this.#blockStartTime) / 1000;
    const bpm = this.#group === 'slow' ? CONFIG.SLOW_BPM : this.#naturalBpm;

    // Spawn
    if (now >= this.#nextSpawnTime) {
      const tOffAtRightEdge = (1.0 - CONFIG.FISH_X_RATIO) / CONFIG.STARFISH_SCROLL_SPEED;
      const spawnNormY = targetCurveY(blockTime + tOffAtRightEdge, bpm);
      this.#starfishes.push({
        xRatio:   1.0,
        normY:    spawnNormY,
        checked:  false,
        collected: false,
        missed:   false,
        collectT: null,
        missT:    null,
      });
      this.#nextSpawnTime = now + randBetween(CONFIG.STARFISH_SPAWN_MIN_MS, CONFIG.STARFISH_SPAWN_MAX_MS);
    }

    // Update each starfish
    for (const star of this.#starfishes) {
      star.xRatio -= CONFIG.STARFISH_SCROLL_SPEED * dt;

      // Keep star on the curve until it's been checked
      if (!star.checked) {
        const tOff   = (star.xRatio - CONFIG.FISH_X_RATIO) / CONFIG.STARFISH_SCROLL_SPEED;
        star.normY   = targetCurveY(blockTime + tOff, bpm);

        // Collection check: when star crosses the fish's x
        if (star.xRatio <= CONFIG.FISH_X_RATIO) {
          star.checked = true;
          const dy = Math.abs(star.normY - this.#fishNormY);
          if (dy < CONFIG.STARFISH_HIT_RADIUS) {
            this.#collectStar(star, blockTime);
          } else {
            this.#missStar(star, blockTime);
          }
        }
      }

      // Advance outcome animations
      if (star.collected) star.collectT += dt;
      if (star.missed)    star.missT    += dt;
    }

    // Prune — off-screen and finished animations
    this.#starfishes = this.#starfishes.filter(s =>
      s.xRatio > -0.15 &&
      ((!s.collected && !s.missed) || (s.collectT ?? s.missT) < 0.65)
    );
  }

  #collectStar(star, blockTime) {
    star.collected = true;
    star.collectT  = 0;
    this.#scoreBlock[this.#blockIndex]++;
    this.#markers.send(`star_collect_b${this.#blockIndex}_s${this.#scoreBlock[this.#blockIndex]}`);
    this.#csv.appendEvent(this.#blockIndex, 'star_collect',
      this.#scoreBlock[this.#blockIndex], blockTime.toFixed(2));
    // Throttled push to not flood IPC on every collect
    this.#pushState({ score: this.#scoreBlock[this.#blockIndex] });
  }

  #missStar(star, blockTime) {
    star.missed = true;
    star.missT  = 0;
    this.#markers.send(`star_miss_b${this.#blockIndex}`);
    this.#csv.appendEvent(this.#blockIndex, 'star_miss', '', blockTime.toFixed(2));
  }

  // ── Frame data recording ──────────────────────────────────────────────────

  #recordFrame(now) {
    if (now - this.#lastFrameRecord < CONFIG.FRAME_INTERVAL_MS) return;
    this.#lastFrameRecord = now;

    const blockTime = (now - this.#blockStartTime) / 1000;
    const bpm  = this.#group === 'slow' ? CONFIG.SLOW_BPM : this.#naturalBpm;
    const tgt  = targetCurveY(blockTime, bpm);
    const [rMin, rMax] = this.#normRange;

    this.#csv.bufferFrame({
      t:        new Date().toISOString(),
      block:    this.#blockIndex,
      raw:      this.#lastRaw,
      smoothed: this.#smoother.value,
      norm:     this.#fishNormY,
      fishY:    this.#fishNormY,
      targetY:  tgt,
      stars:    this.#starfishes.filter(s => !s.checked).length,
    });
  }

  // ── Render data builder ───────────────────────────────────────────────────

  #buildRenderData(now, dt) {
    const blockTime    = this.#blockStartTime != null ? (now - this.#blockStartTime) / 1000 : 0;
    const blockElapsed = blockTime;
    const bpm  = this.#group === 'slow' ? CONFIG.SLOW_BPM : this.#naturalBpm;
    const calElapsed   = this.#calStartTime != null ? (now - this.#calStartTime) / 1000 : 0;

    let countdownValue = 3, countdownProgress = 0;
    if (this.#countdownStartTime != null) {
      const cdE = (now - this.#countdownStartTime) / 1000;
      if      (cdE < 1)    { countdownValue = 3; countdownProgress = cdE; }
      else if (cdE < 2)    { countdownValue = 2; countdownProgress = cdE - 1; }
      else if (cdE < 3)    { countdownValue = 1; countdownProgress = cdE - 2; }
      else                 { countdownValue = 0; countdownProgress = (cdE - 3) / 0.75; }
    }

    return {
      state:             this.#state,
      now,
      bgScrollX:         this.#bgScrollX,
      blockTime,
      bpm,
      fishNormY:         this.#fishNormY,
      fishNormSize:      this.#fishNormY,  // size tracks Y directly
      fishTilt:          this.#fishTilt,
      starfishes:        this.#starfishes,
      score:             this.#scoreBlock[this.#blockIndex],
      blockIndex:        this.#blockIndex,
      scoreBlock1:       this.#scoreBlock[0],
      scoreBlock2:       this.#scoreBlock[1],
      group:             this.#group,
      showCurve:         this.#showCurve,
      blockElapsed,
      calProgress:       clamp(calElapsed / CONFIG.CALIBRATION_SECS, 0, 1),
      calRemaining:      Math.max(0, Math.ceil(CONFIG.CALIBRATION_SECS - calElapsed)),
      countdownValue,
      countdownProgress: clamp(countdownProgress, 0, 1),
    };
  }

  // ── Experimenter state push ───────────────────────────────────────────────

  #setState(s) {
    this.#state = s;
  }

  #pushState(overrides = {}) {
    const score = this.#scoreBlock[this.#blockIndex] ?? 0;
    window.api.frontend.sendState({
      stateText:    `block ${this.#blockIndex + 1} / ${CONFIG.NUM_BLOCKS}`,
      blockText:    `${this.#blockIndex + 1} / ${CONFIG.NUM_BLOCKS}`,
      score,
      startEnabled: this.#streamReady && this.#state === STATE.IDLE,
      startText:    'Start',
      nextVisible:  false,
      abortVisible: false,
      inputsLocked: this.#inputsLocked,
      ...overrides,
    });
  }

  // ── CSV error display ─────────────────────────────────────────────────────

  #csvWarn(msg) {
    console.error('[BioGame CSV]', msg);
    this.#pushState({ stateText: `⚠ CSV: ${msg}` });
  }
}
