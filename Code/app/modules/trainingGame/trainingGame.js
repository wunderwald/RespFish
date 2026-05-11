import { CONFIG, STATE }                         from './trainingGame_config.js';
import { Cloud, Particle, TrainingGameRenderer } from './trainingGame_renderer.js';

export class TrainingGame {
  // state
  #state = STATE.IDLE;
  #score = 0;

  // countdown
  #countdownStart = null;

  // breath tracking
  #phase = 'inhale';
  #phaseStartTime = null;
  #exhaleTimeAbove = 0;
  #lastBreathMs = -Infinity;
  #inBreath = false;
  #lastSampleTime = null;
  #lastNorm = 0;

  // timing
  #beatMs = (60 / CONFIG.TARGET_BPM) * 1000;
  #gameStartTime = null;

  // variant
  #variant      = 'target'; // 'target' | 'control'
  #exhaleWindow = null;      // ms; set in #beginPlaying based on variant

  // clouds & particles
  #activeCloud = null;
  #failedClouds = [];
  #failAngleIndex = 0;
  #particles = [];

  // animation
  #lastFrameTime = null;
  #lastDebugPush = 0;
  #spawnTimeoutId = null;
  #heldSadness = 0;

  // HUD state
  #hudStateText  = 'waiting for stream…';
  #hudScore      = null;
  #hudBtnEnabled = false;
  #hudBtnText    = 'Start';

  // renderer
  #renderer;

  constructor({ statsContainer, sceneContainer }) {
    this.#renderer = new TrainingGameRenderer(sceneContainer);

    window.api.frontend.onAction(({ type, variant }) => {
      if (type === 'start') this.#beginCountdown(variant ?? 'target');
    });

    this.#pushState();
    setInterval(() => this.#tick(), 100);
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // ── Frontend interface ─────────────────────────────────────────────────────

  pushSample(value) {
    const now = performance.now();
    const dt = this.#lastSampleTime != null ? now - this.#lastSampleTime : 0;
    this.#lastSampleTime = now;
    if (this.#state === STATE.PLAYING) this.#tickBreath(value, now, dt);
  }

  setStatus({ type, text }) {
    if (this.#state !== STATE.IDLE) return;
    const streamReady = type === 'connected';
    this.#hudStateText  = streamReady ? 'ready — press Start' : text;
    this.#hudBtnEnabled = streamReady;
    this.#pushState();
  }

  // ── HUD state push ─────────────────────────────────────────────────────────

  #pushState() {
    window.api.frontend.sendState({
      stateText:  this.#hudStateText,
      score:      this.#hudScore,
      btnEnabled: this.#hudBtnEnabled,
      btnText:    this.#hudBtnText,
    });
  }

  // ── State machine ──────────────────────────────────────────────────────────

  #beginCountdown(variant = 'target') {
    this.#variant = variant;
    this.#state = STATE.COUNTDOWN;
    this.#countdownStart = performance.now();
    this.#hudStateText  = 'get ready…';
    this.#hudBtnEnabled = false;
    this.#pushState();
    window.api.frontend.sendState({ inputsLocked: true });
  }

  #beginPlaying() {
    clearTimeout(this.#spawnTimeoutId);
    this.#state = STATE.PLAYING;
    this.#score = 0;
    this.#heldSadness = 0;
    this.#activeCloud = null;
    this.#failedClouds = [];
    this.#failAngleIndex = 0;
    this.#particles = [];
    this.#phase = 'inhale';
    this.#phaseStartTime = performance.now();
    this.#lastBreathMs = -Infinity;
    this.#gameStartTime = performance.now();
    this.#exhaleWindow = this.#variant === 'control'
      ? CONFIG.SHARP_EXHALE_MS
      : this.#beatMs / 2;

    this.#hudStateText  = 'playing';
    this.#hudScore      = 0;
    this.#hudBtnText    = 'Restart';
    this.#hudBtnEnabled = true;
    this.#pushState();
    this.#spawnCloud();
  }

  #endGame() {
    clearTimeout(this.#spawnTimeoutId);
    this.#state = STATE.GAME_OVER;
    this.#activeCloud = null;
    this.#failedClouds = [];
    this.#particles = [];
    this.#hudStateText  = 'game over';
    this.#hudBtnText    = 'Play again';
    this.#hudBtnEnabled = true;
    this.#pushState();
    window.api.frontend.sendState({ debugLog: null });
  }

  // ── Tick — state transitions (setInterval, 100 ms) ────────────────────────

  #tick() {
    const now = performance.now();
    if (this.#state === STATE.COUNTDOWN && now - this.#countdownStart >= 3500) {
      this.#beginPlaying();
    } else if (this.#state === STATE.PLAYING && now - this.#gameStartTime >= CONFIG.GAME_DURATION_SECS * 1000) {
      this.#endGame();
    } else if (this.#state === STATE.PLAYING &&
               this.#phase === 'inhale' &&
               this.#activeCloud !== null &&
               this.#phaseStartTime != null &&
               now - this.#phaseStartTime >= (this.#variant === 'control' ? CONFIG.SHARP_CLOUD_TIMEOUT_MS : this.#beatMs / 2)) {
      this.#exhaleTimeAbove = 0;
      this.#onExhaleEnd(now);
    }
  }

  // ── RAF loop ───────────────────────────────────────────────────────────────

  #rafLoop(timestamp) {
    const dt = this.#lastFrameTime != null ? timestamp - this.#lastFrameTime : 16;
    this.#lastFrameTime = timestamp;

    const c = this.#renderer.canvas;
    c.width  = c.offsetWidth;
    c.height = c.offsetHeight;

    if (this.#state === STATE.PLAYING || this.#state === STATE.COUNTDOWN) {
      this.#updateVisuals(dt);
    }

    if (this.#state === STATE.PLAYING) this.#pushDebugLog(timestamp);

    try {
      this.#renderer.draw(this.#buildRenderData(timestamp));
    } catch (e) {
      console.error('[TrainingGame] draw error:', e);
    }

    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  #updateVisuals(dt) {
    if (this.#activeCloud) this.#activeCloud.tick(dt);
    for (const c of this.#failedClouds) c.tick(dt);
    this.#failedClouds = this.#failedClouds.filter(c => c.alive);
    for (const p of this.#particles) p.tick(dt);
    this.#particles = this.#particles.filter(p => p.alive);
  }

  #buildRenderData(now) {
    return {
      state:            this.#state,
      countdownElapsed: this.#countdownStart != null ? now - this.#countdownStart : 0,
      score:            this.#score,
      gameElapsed:      this.#gameStartTime != null ? (now - this.#gameStartTime) / 1000 : 0,
      activeCloud:      this.#activeCloud,
      failedClouds:     this.#failedClouds,
      particles:        this.#particles,
      phase:            this.#phase,
      inBreath:         this.#inBreath,
      lastNorm:         this.#lastNorm,
      exhaleProgress:   this.#phase === 'exhale' && this.#exhaleWindow
        ? Math.min(1, this.#exhaleTimeAbove / this.#exhaleWindow)
        : 0,
      heldSadness:      this.#heldSadness,
      variant:          this.#variant,
      now,
    };
  }

  #pushDebugLog(now) {
    if (now - this.#lastDebugPush < 150) return;
    this.#lastDebugPush = now;
    const phaseLabel  = this.#phase === 'exhale'
      ? (this.#variant === 'control' ? 'PUFF!' : 'BREATHE OUT')
      : (this.#variant === 'control' ? 'waiting…' : 'BREATHE IN');
    const signalLabel = this.#inBreath ? 'exhaling' : 'inhaling';
    window.api.frontend.sendState({
      debugLog: `${phaseLabel}  ·  signal: ${this.#lastNorm.toFixed(2)}  (${signalLabel})`,
    });
  }

  // ── Breath tracking ────────────────────────────────────────────────────────

  #tickBreath(value, now, dt) {
    const norm = value;
    const above = norm >= CONFIG.EXHALE_ONSET_THRESHOLD;
    this.#lastNorm = norm;

    if (this.#phase === 'inhale') {
      const cloudCovering = this.#activeCloud?._state === 'covering';
      if (above && !this.#inBreath && cloudCovering && now - this.#lastBreathMs > CONFIG.BREATH_DEBOUNCE_MS) {
        this.#onExhaleOnset(now);
      }
    } else {
      if (above) this.#exhaleTimeAbove += dt;
      if (now - this.#phaseStartTime >= this.#exhaleWindow) {
        this.#onExhaleEnd(now);
      }
    }

    this.#inBreath = above;
  }

  #onExhaleOnset(now) {
    this.#phase = 'exhale';
    this.#phaseStartTime = now;
    this.#exhaleTimeAbove = 0;
    this.#lastBreathMs = now;
  }

  #onExhaleEnd(now) {
    const exhalePhaseMs = this.#exhaleWindow ?? this.#beatMs / 2;
    const ratio = this.#exhaleTimeAbove / exhalePhaseMs;
    const success = ratio >= CONFIG.EXHALE_SUCCESS_RATIO;
    let prevSadness = 0;

    if (this.#activeCloud) {
      if (success) {
        this.#score++;
        this.#hudScore = this.#score;
        this.#pushState();
        this.#activeCloud.succeed();
        this.#burstParticles(this.#activeCloud.x, this.#activeCloud.y);
      } else {
        const c = this.#renderer.canvas;
        const angle = (this.#failAngleIndex * Math.PI * 2) / 12;
        const failX = c.width  / 2 + Math.cos(angle) * CONFIG.FAIL_ORBIT_R;
        const failY = c.height / 2 + Math.sin(angle) * CONFIG.FAIL_ORBIT_R;
        this.#activeCloud._startExhaleProgress = Math.min(1, ratio);
        this.#activeCloud.slideTo(failX, failY);
        this.#failedClouds.push(this.#activeCloud);
        this.#failAngleIndex = (this.#failAngleIndex + 1) % 12;
        prevSadness = 1 - Math.min(1, ratio);
        this.#heldSadness = prevSadness;
      }
      this.#activeCloud = null;
    }

    this.#phase = 'inhale';
    this.#phaseStartTime = now;
    const spawnDelay = this.#variant === 'control'
      ? CONFIG.SHARP_SPAWN_MIN_MS + Math.random() * (CONFIG.SHARP_SPAWN_MAX_MS - CONFIG.SHARP_SPAWN_MIN_MS)
      : CONFIG.CLOUD_SPAWN_DELAY_MS;
    this.#spawnTimeoutId = setTimeout(() => {
      if (this.#state !== STATE.PLAYING) return;
      this.#spawnCloud();
      if (this.#activeCloud) this.#activeCloud._prevSadness = this.#heldSadness;
      this.#heldSadness = 0;
    }, spawnDelay);
  }

  #burstParticles(x, y) {
    for (let i = 0; i < 22; i++) this.#particles.push(new Particle(x, y));
  }

  #spawnCloud() {
    const c = this.#renderer.canvas;
    const cx = c.width / 2;
    const cy = c.height / 2;
    const margin = 120;

    const edge = Math.floor(Math.random() * 4);
    const [sx, sy] = [
      [Math.random() * c.width, -margin],
      [c.width + margin, Math.random() * c.height],
      [Math.random() * c.width, c.height + margin],
      [-margin, Math.random() * c.height],
    ][edge];

    this.#activeCloud = new Cloud({ startX: sx, startY: sy, sunX: cx, sunY: cy, slideInMs: CONFIG.CLOUD_SLIDE_IN_MS });
  }
}

export default TrainingGame;
