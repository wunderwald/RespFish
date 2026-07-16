/**
 * bioGame.js — Biofeedback breath-control game
 * =============================================
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
import { RespCalibration }  from '../calibration/calibration.js';
import { MarkerStream }     from '../stream/markerStream.js';
import { CONFIG, STATE }    from './bioGame_config.js';
import { BioGameRenderer }  from './bioGame_renderer.js';
import { BioGameCSV }       from './bioGame_csv.js';
import { BioGameSound }     from './bioGame_sound.js';
import { resolveScene }     from './bioGame_scene.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function randBetween(lo, hi) { return lo + Math.random() * (hi - lo); }

function targetCurveY(t, bpm) {
  return 0.5 + 0.45 * Math.sin(2 * Math.PI * (t / (60 / bpm)));
}

// ── BioGame ───────────────────────────────────────────────────────────────────

export default class BioGame {
  // ── Scene ─────────────────────────────────────────────────────────────────
  #scene = null;

  // ── State ─────────────────────────────────────────────────────────────────
  #state        = STATE.IDLE;
  #streamReady  = false;
  #inputsLocked = false;

  // ── Particles + avatar bump ───────────────────────────────────────────────
  #particles    = [];
  #avatarBumpT  = null;

  // ── Experiment settings (overridden by experimenter on start) ─────────────
  #subjectCode      = CONFIG.SUBJECT_CODE;
  #group            = CONFIG.GROUP;
  #naturalBpm       = CONFIG.NATURAL_BPM;
  #showCurve        = CONFIG.SHOW_CURVE;
  #calibrationSecs  = CONFIG.CALIBRATION_SECS;

  // ── Block management ──────────────────────────────────────────────────────
  #blockIndex       = 0;
  #blockStartTime   = null;
  #scoreBlock       = [0, 0];

  // ── Trial markers ─────────────────────────────────────────────────────────
  #trialIndex    = 0;
  #nextTrialTime = null;

  // ── Signal processing ─────────────────────────────────────────────────────
  #smoother         = new GaussianSmoother(CONFIG.SMOOTH_WINDOW);
  #lastRaw          = 0;
  #calibration      = null;
  #calFailed        = false;
  #normRange        = [0, 1];

  // ── Avatar state ──────────────────────────────────────────────────────────
  #avatarNormY     = 0.5;
  #prevAvatarNormY = 0.5;
  #avatarTilt      = 0;

  // ── Stress mechanic ───────────────────────────────────────────────────────
  #avatarStressNorm = CONFIG.AVATAR_STRESS_INIT;
  #speedNorm        = CONFIG.SCROLL_SPEED_INIT;
  #missCount        = 0;
  #gameOver         = false;

  // ── Items ─────────────────────────────────────────────────────────────────
  #items         = [];
  #nextSpawnTime = 0;

  // ── Countdown ────────────────────────────────────────────────────────────
  #countdownStartTime = null;

  // ── Background scroll ────────────────────────────────────────────────────
  #bgScrollX = 0;

  // ── Data / frame recording ───────────────────────────────────────────────
  #csv             = null;
  #lastFrameRecord = 0;

  // ── Timing ────────────────────────────────────────────────────────────────
  #lastRafTime = null;

  // ── Sub-modules ───────────────────────────────────────────────────────────
  #markers  = null;
  #renderer = null;
  #sound    = null;

  // ── Derived ───────────────────────────────────────────────────────────────

  get #activeBpm() {
    return this.#group === 'slow' ? CONFIG.SLOW_BPM : this.#naturalBpm;
  }

  get #scrollSpeed() {
    return lerp(CONFIG.SCROLL_SPEED_MIN, CONFIG.SCROLL_SPEED_MAX, this.#speedNorm);
  }

  constructor({ sceneContainer }) {
    this.#scene   = resolveScene(CONFIG.SCENE);
    this.#renderer = new BioGameRenderer(sceneContainer, this.#scene);

    this.#sound = new BioGameSound();
    this.#sound.init(this.#scene.sounds).catch(e => console.warn('[BioGame] sound init failed:', e));

    this.#markers = CONFIG.SEND_MARKERS
      ? new MarkerStream(CONFIG.MARKER_STREAM_URL)
      : { send() {} };

    window.api.frontend.onAction((action) => this.#onAction(action));

    setInterval(() => this.#tick(), 100);
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // ── Public interface ──────────────────────────────────────────────────────

  pushSample(rawValue) {
    this.#lastRaw = rawValue;
    this.#smoother.push(rawValue);

    if (this.#state === STATE.CALIBRATING) {
      this.#calibration.push(this.#smoother.value);
    }
  }

  setStatus({ type, text }) {
    this.#streamReady = (type === 'connected');
    if (this.#state === STATE.IDLE) {
      this.#pushState({
        stateText:    this.#streamReady ? 'stream ready' : (text ?? 'no stream'),
        startEnabled: this.#streamReady,
      });
    }
  }

  // ── Action handler ────────────────────────────────────────────────────────

  #onAction({ type, subjectCode, group, naturalBpm, showCurve, calibrationSecs }) {
    switch (type) {
      case 'start':
        if (subjectCode     !== undefined) this.#subjectCode     = subjectCode;
        if (group           !== undefined) this.#group           = group;
        if (naturalBpm      !== undefined) this.#naturalBpm      = naturalBpm;
        if (showCurve       !== undefined) this.#showCurve       = showCurve;
        if (calibrationSecs !== undefined) this.#calibrationSecs = calibrationSecs;
        if (this.#state === STATE.IDLE && this.#streamReady) this.#beginCalibration();
        break;

      case 'next':
        if (this.#state === STATE.INTERMISSION || this.#state === STATE.READY)
          this.#startCountdown();
        break;

      case 'abort':
        if (this.#state === STATE.PLAYING) this.#endBlock(true);
        break;

      case 'retryCalibration':
        if (this.#state === STATE.CALIBRATING && this.#calFailed) this.#retryCalibration();
        break;

      case 'useDefaultCalibration':
        if (this.#state === STATE.CALIBRATING && this.#calFailed) this.#useDefaultCalibration();
        break;

      case 'ready':
        this.#pushState();
        break;
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────

  #beginCalibration() {
    this.#calibration = new RespCalibration({ durationSecs: this.#calibrationSecs });
    this.#calibration.start();
    this.#calFailed = false;
    this.#smoother.reset();
    this.#inputsLocked = true;
    this.#blockIndex   = 0;
    this.#scoreBlock   = [0, 0];
    this.#trialIndex   = 0;

    this.#csv = new BioGameCSV(
      this.#subjectCode, this.#group, this.#scene.id,
      (msg) => this.#csvWarn(msg)
    );
    this.#csv.init();

    this.#state = STATE.CALIBRATING;
    this.#markers.send('calibration_start');
    this.#pushState({ stateText: 'calibrating…', abortVisible: false, inputsLocked: true });
  }

  #finishCalibration() {
    this.#markers.send('calibration_end');
    const result = this.#calibration.finish();

    if (!result) {
      console.warn('[BioGame] calibration produced no samples');
      this.#markers.send('calibration_failed');
      this.#calFailed = true;
      this.#pushState({
        stateText: '⚠ calibration failed — no signal received',
        calFailed: true,
      });
      return;
    }

    this.#completeCalibration([result.min, result.max]);
  }

  #completeCalibration(range) {
    this.#normRange = range;
    console.log(`[BioGame] norm range: [${range[0].toFixed(3)}, ${range[1].toFixed(3)}]`);

    this.#state = STATE.READY;
    this.#pushState({ stateText: 'ready — press Space or Start', nextVisible: true, calFailed: false });
  }

  #retryCalibration() {
    this.#calibration.start();
    this.#calFailed = false;
    this.#markers.send('calibration_start');
    this.#pushState({ stateText: 'calibrating…', calFailed: false });
  }

  #useDefaultCalibration() {
    this.#markers.send('calibration_default_used');
    this.#completeCalibration(CONFIG.DEFAULT_CAL_RANGE);
  }

  #startCountdown() {
    this.#countdownStartTime = performance.now();
    this.#state = STATE.COUNTDOWN;
    this.#markers.send(`countdown_start_block${this.#blockIndex}`);
    this.#pushState({ stateText: 'starting…', nextVisible: false });
  }

  #startBlock() {
    this.#blockStartTime  = performance.now();
    this.#lastFrameRecord = performance.now();
    this.#items           = [];
    this.#nextSpawnTime   = performance.now() +
      randBetween(CONFIG.ITEM_SPAWN_MIN_MS, CONFIG.ITEM_SPAWN_MAX_MS);
    this.#avatarStressNorm = CONFIG.AVATAR_STRESS_INIT;
    this.#speedNorm        = CONFIG.SCROLL_SPEED_INIT;
    this.#missCount        = 0;
    this.#gameOver         = false;

    this.#csv.initBlockCSV(this.#blockIndex);
    this.#nextTrialTime = (60 / this.#activeBpm) * 0.75;

    this.#sound.startBlock();
    this.#state = STATE.PLAYING;
    this.#markers.send(`block_start_${this.#blockIndex}`);
    this.#pushState({
      stateText:   `game ${this.#blockIndex + 1} / ${CONFIG.NUM_BLOCKS}`,
      abortVisible: true,
    });
  }

  #endBlock(aborted = false) {
    this.#sound.stopBlock();
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
    this.#state = STATE.INTERMISSION;
    this.#pushState({
      stateText:    'intermission',
      score:        this.#scoreBlock[0],
      abortVisible: false,
      nextVisible:  true,
    });
  }

  #endExperiment() {
    this.#state = STATE.DONE;
    this.#markers.send('experiment_done');
    const total = this.#scoreBlock[0] + this.#scoreBlock[1];
    this.#pushState({ stateText: 'done', abortVisible: false, nextVisible: false, score: total });
  }

  // ── Update loop ───────────────────────────────────────────────────────────

  #tick() {
    const now = performance.now();

    if (this.#state === STATE.CALIBRATING && !this.#calFailed) {
      if (this.#calibration.isDone) {
        this.#finishCalibration();
      }
    }

    if (this.#state === STATE.COUNTDOWN) {
      if ((now - this.#countdownStartTime) / 1000 >= CONFIG.COUNTDOWN_SECS) {
        this.#startBlock();
      }
    }

    if (this.#state === STATE.PLAYING) {
      if ((now - this.#blockStartTime) / 1000 >= CONFIG.BLOCK_DURATION_SECS) {
        this.#endBlock(false);
      }
    }
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────

  #rafLoop(now) {
    const dt = this.#lastRafTime != null ? clamp((now - this.#lastRafTime) / 1000, 0, 0.05) : 0;
    this.#lastRafTime = now;

    if (this.#state === STATE.PLAYING || this.#state === STATE.CALIBRATING) {
      this.#updateSignal(dt);
    }

    if (this.#state === STATE.PLAYING) {
      this.#sound.setNoiseLevel(this.#avatarNormY);
      this.#bgScrollX += this.#scrollSpeed * CONFIG.BG_SCROLL_FACTOR * dt;
      this.#updateItems(now, dt);
      this.#updateParticles(dt);
      this.#updateAvatarBump(dt);
      this.#checkTrialMarker((now - this.#blockStartTime) / 1000);
      this.#recordFrame(now);
    }

    try {
      this.#renderer.draw(this.#buildRenderData(now, dt));
    } catch (e) {
      console.error('[BioGame] draw error:', e);
    }

    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // ── Signal normalization ──────────────────────────────────────────────────

  #updateSignal(dt) {
    const [rMin, rMax] = this.#normRange;
    const range = rMax - rMin || 1e-6;
    const norm  = clamp((this.#smoother.value - rMin) / range, 0, 1);

    this.#prevAvatarNormY = this.#avatarNormY;
    this.#avatarNormY     = norm;

    const vel = dt > 0 ? (norm - this.#prevAvatarNormY) / dt : 0;
    const tgt = clamp(-vel * 1.8, -Math.PI / 6, Math.PI / 6);
    this.#avatarTilt = lerp(this.#avatarTilt, tgt, 1 - Math.exp(-dt / 0.18));
  }

  // ── Item spawning and movement ────────────────────────────────────────────

  #updateItems(now, dt) {
    const blockTime = (now - this.#blockStartTime) / 1000;
    const bpm   = this.#activeBpm;
    const speed = this.#scrollSpeed;

    if (now >= this.#nextSpawnTime) {
      const tOffAtRightEdge = (1.0 - CONFIG.AVATAR_X_RATIO) / speed;
      this.#items.push({
        xRatio:    1.0,
        normY:     targetCurveY(blockTime + tOffAtRightEdge, bpm),
        checked:   false,
        collected: false,
        missed:    false,
        collectT:  null,
        missT:     null,
      });
      this.#nextSpawnTime = now + randBetween(CONFIG.ITEM_SPAWN_MIN_MS, CONFIG.ITEM_SPAWN_MAX_MS);
    }

    for (const item of this.#items) {
      item.xRatio -= speed * dt;

      if (!item.checked) {
        const tOff = (item.xRatio - CONFIG.AVATAR_X_RATIO) / speed;
        item.normY = targetCurveY(blockTime + tOff, bpm);

        if (item.xRatio <= CONFIG.AVATAR_X_RATIO) {
          item.checked = true;
          if (Math.abs(item.normY - this.#avatarNormY) < CONFIG.ITEM_HIT_RADIUS) {
            this.#collectItem(item, blockTime);
          } else {
            this.#missItem(item, blockTime);
          }
        }
      }

      if (item.collected) item.collectT += dt;
      if (item.missed)    item.missT    += dt;
    }

    this.#items = this.#items.filter(s =>
      s.xRatio > -0.15 &&
      ((!s.collected && !s.missed) || (s.collectT ?? s.missT) < 0.65)
    );
  }

  #collectItem(item, blockTime) {
    item.collected = true;
    item.collectT  = 0;
    this.#scoreBlock[this.#blockIndex]++;
    this.#avatarStressNorm = clamp(this.#avatarStressNorm + CONFIG.STRESS_GROW_STEP,  0, 1);
    this.#speedNorm        = clamp(this.#speedNorm        + CONFIG.SPEED_GROW_STEP,   0, 1);
    this.#markers.send(`item_collect_b${this.#blockIndex}_s${this.#scoreBlock[this.#blockIndex]}`);
    this.#csv.appendEvent(this.#blockIndex, 'item_collect',
      this.#scoreBlock[this.#blockIndex], blockTime.toFixed(2));
    this.#burstParticles(item.xRatio, item.normY);
    this.#avatarBumpT = 0;
    this.#sound.playCollect();
    this.#pushState({ score: this.#scoreBlock[this.#blockIndex] });
  }

  #missItem(item, blockTime) {
    item.missed = true;
    item.missT  = 0;
    this.#avatarStressNorm = clamp(this.#avatarStressNorm - CONFIG.STRESS_SHRINK_STEP, 0, 1);
    this.#speedNorm        = clamp(this.#speedNorm        - CONFIG.SPEED_SHRINK_STEP,  0, 1);
    this.#missCount++;
    this.#sound.playMiss();
    this.#markers.send(`item_miss_b${this.#blockIndex}`);
    this.#csv.appendEvent(this.#blockIndex, 'item_miss', '', blockTime.toFixed(2));
    if (this.#missCount >= CONFIG.MISS_GAME_OVER) {
      this.#gameOver = true;
      this.#endBlock(false);
    }
  }

  // ── Particles ─────────────────────────────────────────────────────────────

  static #BURST_COLORS = ['#ffe066', '#ffb347', '#fffbe6', '#ffd700', '#ff9f43'];

  #burstParticles(xRatio, normY) {
    for (let i = 0; i < 18; i++) {
      const angle = (i / 18) * Math.PI * 2 + randBetween(-0.2, 0.2);
      const speed = randBetween(0.08, 0.22);
      this.#particles.push({
        x:     xRatio,
        y:     normY,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed,
        life:  1,
        color: BioGame.#BURST_COLORS[Math.floor(Math.random() * BioGame.#BURST_COLORS.length)],
        r:     randBetween(0.003, 0.007),
      });
    }
  }

  #updateParticles(dt) {
    for (const p of this.#particles) {
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.vy   -= 0.25 * dt;
      p.life -= dt * 2.2;
    }
    this.#particles = this.#particles.filter(p => p.life > 0);
  }

  #updateAvatarBump(dt) {
    if (this.#avatarBumpT === null) return;
    this.#avatarBumpT += dt;
    if (this.#avatarBumpT > 0.3) this.#avatarBumpT = null;
  }

  // ── Frame data recording ──────────────────────────────────────────────────

  #recordFrame(now) {
    if (now - this.#lastFrameRecord < CONFIG.FRAME_INTERVAL_MS) return;
    this.#lastFrameRecord = now;

    this.#csv.bufferFrame({
      t:         new Date().toISOString(),
      block:     this.#blockIndex,
      raw:       this.#lastRaw,
      smoothed:  this.#smoother.value,
      norm:      this.#avatarNormY,
      avatarY:   this.#avatarNormY,
      targetY:   targetCurveY((now - this.#blockStartTime) / 1000, this.#activeBpm),
      itemCount: this.#items.filter(s => !s.checked).length,
    });
  }

  // ── Render data builder ───────────────────────────────────────────────────

  #buildRenderData(now, dt) {
    const blockTime  = this.#blockStartTime != null ? (now - this.#blockStartTime) / 1000 : 0;

    let countdownValue = 3, countdownProgress = 0;
    if (this.#countdownStartTime != null) {
      const cdE = (now - this.#countdownStartTime) / 1000;
      if      (cdE < 1) { countdownValue = 3; countdownProgress = cdE; }
      else if (cdE < 2) { countdownValue = 2; countdownProgress = cdE - 1; }
      else if (cdE < 3) { countdownValue = 1; countdownProgress = cdE - 2; }
      else              { countdownValue = 0; countdownProgress = (cdE - 3) / 0.75; }
    }

    return {
      state:             this.#state,
      now,
      bgScrollX:         this.#bgScrollX,
      blockTime,
      bpm:               this.#activeBpm,
      avatarNormY:       this.#avatarNormY,
      avatarStressNorm:  this.#avatarStressNorm,
      avatarTilt:        this.#avatarTilt,
      avatarBumpT:       this.#avatarBumpT,
      items:             this.#items,
      particles:         this.#particles,
      score:             this.#scoreBlock[this.#blockIndex],
      blockIndex:        this.#blockIndex,
      scoreBlock1:       this.#scoreBlock[0],
      scoreBlock2:       this.#scoreBlock[1],
      group:             this.#group,
      showCurve:         this.#showCurve,
      scrollSpeed:       this.#scrollSpeed,
      missCount:         this.#missCount,
      gameOver:          this.#gameOver,
      calProgress:       this.#calibration?.progress ?? 0,
      calRemaining:      Math.ceil(this.#calibration?.remainingSecs ?? this.#calibrationSecs),
      countdownValue,
      countdownProgress: clamp(countdownProgress, 0, 1),
    };
  }

  // ── Experimenter state push ───────────────────────────────────────────────

  #pushState(overrides = {}) {
    window.api.frontend.sendState({
      stateText:    `game ${this.#blockIndex + 1} / ${CONFIG.NUM_BLOCKS}`,
      score:        this.#scoreBlock[this.#blockIndex] ?? 0,
      startEnabled: this.#streamReady && this.#state === STATE.IDLE,
      startText:    'Start',
      nextVisible:  false,
      abortVisible: false,
      calFailed:    false,
      inputsLocked: this.#inputsLocked,
      ...overrides,
    });
  }

  // ── Trial marker ─────────────────────────────────────────────────────────

  #checkTrialMarker(blockTimeSecs) {
    if (this.#nextTrialTime === null) return;
    const period = 60 / this.#activeBpm;
    while (blockTimeSecs >= this.#nextTrialTime) {
      this.#markers.send(`trial_${++this.#trialIndex}`);
      this.#nextTrialTime += period;
    }
  }

  // ── CSV error display ─────────────────────────────────────────────────────

  #csvWarn(msg) {
    console.error('[BioGame CSV]', msg);
    this.#pushState({ stateText: `⚠ CSV: ${msg}` });
  }
}
