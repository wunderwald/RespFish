/**
 * game.js — Breath-controlled sun & cloud game
 * ==============================================
 * A sun sits in the center. On each exhale onset a cloud slides in to cover it.
 * The child must blow into the microphone for ≥ EXHALE_SUCCESS_RATIO of the
 * exhale phase (half the breath cycle). Success → cloud fades out quickly.
 * Failure → cloud drifts to an orbit position around the sun and fades slowly.
 *
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function easeOut(t)     { return 1 - (1 - t) * (1 - t); }

// ── Configuration ─────────────────────────────────────────────────────────────

export const CONFIG = {
  TARGET_BPM:             6,     // target breaths per minute
  GAME_DURATION_SECS:     60,
  EXHALE_ONSET_THRESHOLD: 0.40,   // normalised signal level that triggers exhale onset
  BREATH_DEBOUNCE_MS:     1500,   // minimum ms between two exhale onsets
  EXHALE_SUCCESS_RATIO:   0.90,   // fraction of exhale phase above threshold needed to clear a cloud

  SUN_RADIUS:      110,
  CLOUD_SIZE:      95,
  CLOUD_SLIDE_MS:  2200,   // ms for cloud to animate in / out
  FAIL_ORBIT_R:    185,    // distance from sun center where failed clouds rest
  FAIL_FADE_MS:    60000,  // ms for a failed cloud to fully fade (1 minute)
};

// ── Game states ───────────────────────────────────────────────────────────────

const STATE = {
  IDLE:      'idle',
  COUNTDOWN: 'countdown',
  PLAYING:   'playing',
  GAME_OVER: 'game_over',
};

// ── Cloud ─────────────────────────────────────────────────────────────────────

class Cloud {
  constructor({ startX, startY, sunX, sunY }) {
    this.x = startX;
    this.y = startY;
    this._fromX = startX;
    this._fromY = startY;
    this._toX   = sunX;
    this._toY   = sunY;
    this.sunX   = sunX;
    this.sunY   = sunY;
    this.size   = CONFIG.CLOUD_SIZE;
    this.alpha  = 1;
    this._state = 'sliding_in'; // sliding_in | covering | success_fade | sliding_out | resting
    this._t     = 0;
  }

  get alive() { return this._state !== 'gone'; }

  succeed() {
    this._state = 'success_fade';
  }

  slideTo(targetX, targetY) {
    this._state = 'sliding_out';
    this._t     = 0;
    this._fromX = this.x;
    this._fromY = this.y;
    this._toX   = targetX;
    this._toY   = targetY;
  }

  tick(dt) {
    const speed = dt / CONFIG.CLOUD_SLIDE_MS;

    if (this._state === 'sliding_in') {
      this._t = Math.min(this._t + speed, 1);
      this.x  = lerp(this._fromX, this._toX, easeOut(this._t));
      this.y  = lerp(this._fromY, this._toY, easeOut(this._t));
      if (this._t >= 1) this._state = 'covering';

    } else if (this._state === 'success_fade') {
      this.alpha = Math.max(0, this.alpha - dt / 700);
      this.y    -= dt * 0.06;   // drift upward as it fades
      if (this.alpha <= 0) this._state = 'gone';

    } else if (this._state === 'sliding_out') {
      this._t = Math.min(this._t + speed, 1);
      this.x  = lerp(this._fromX, this._toX, easeOut(this._t));
      this.y  = lerp(this._fromY, this._toY, easeOut(this._t));
      if (this._t >= 1) this._state = 'resting';

    } else if (this._state === 'resting') {
      this.alpha = Math.max(0, this.alpha - dt / CONFIG.FAIL_FADE_MS);
      if (this.alpha <= 0) this._state = 'gone';
    }
  }
}

// ── Particle ──────────────────────────────────────────────────────────────────

const PARTICLE_COLORS = ['#ffffff', '#fff7aa', '#ffe066', '#ffffff', '#ffffff'];

class Particle {
  constructor(x, y) {
    const angle  = Math.random() * Math.PI * 2;
    const speed  = 60 + Math.random() * 140;
    this.x       = x;
    this.y       = y;
    this.vx      = Math.cos(angle) * speed;
    this.vy      = Math.sin(angle) * speed;
    this.r       = 2.5 + Math.random() * 4;
    this.color   = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
    this.life    = 450 + Math.random() * 300;
    this.elapsed = 0;
  }

  get alive() { return this.elapsed < this.life; }

  tick(dt) {
    this.elapsed += dt;
    this.x += this.vx * dt / 1000;
    this.y += this.vy * dt / 1000;
  }

  get alpha() { return Math.max(0, 1 - this.elapsed / this.life); }
}

// ── Game ──────────────────────────────────────────────────────────────────────

export class Game {
  // game state
  #state = STATE.IDLE;
  #score = 0;

  // countdown
  #countdownStart = null;

  // breath tracking
  #phase           = 'inhale'; // 'inhale' | 'exhale'
  #phaseStartTime  = null;
  #exhaleTimeAbove = 0;        // accumulated ms above threshold in current exhale phase
  #lastBreathMs    = -Infinity;
  #inBreath        = false;
  #lastSampleTime  = null;
  #lastNorm        = 0;

  // timing
  #beatMs        = (60 / CONFIG.TARGET_BPM) * 1000; // 5000 ms at 12 BPM
  #gameStartTime = null;

  // clouds
  #activeCloud    = null;
  #failedClouds   = [];
  #failAngleIndex = 0;   // cycles through orbit positions for failed clouds
  #particles      = [];

  // animation
  #lastFrameTime = null;

  // DOM
  #canvas   = null;
  #ctx      = null;
  #scoreEl  = null;
  #stateEl  = null;
  #startBtn = null;

  constructor({ statsContainer, sceneContainer }) {
    this.#buildHUD(statsContainer);
    this.#buildCanvas(sceneContainer);
    requestAnimationFrame((t) => this.#loop(t));
  }

  // ── Frontend interface ───────────────────────────────────────────────────────

  pushSample(value) {
    const now = performance.now();
    const dt  = this.#lastSampleTime != null ? now - this.#lastSampleTime : 0;
    this.#lastSampleTime = now;

    if (this.#state === STATE.PLAYING) {
      this.#tickBreath(value, now, dt);
    }
  }

  setStatus({ type, text }) {
    const streamReady = type === 'connected';
    if (this.#state === STATE.IDLE) {
      this.#stateEl.textContent = streamReady ? 'ready — press Start' : text;
      this.#startBtn.disabled   = !streamReady;
    }
  }

  // ── DOM construction ─────────────────────────────────────────────────────────

  #buildHUD(container) {
    container.innerHTML = `
      <span id="game-state-text">waiting for stream…</span>
      <span><span class="label">score</span><span id="game-score">—</span></span>
      <button id="game-start-btn" disabled>Start</button>
    `;
    this.#stateEl  = container.querySelector('#game-state-text');
    this.#scoreEl  = container.querySelector('#game-score');
    this.#startBtn = container.querySelector('#game-start-btn');
    this.#startBtn.addEventListener('click', () => this.#beginCountdown());
  }

  #buildCanvas(container) {
    container.innerHTML = '<canvas id="game-canvas"></canvas>';
    this.#canvas = container.querySelector('#game-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── State machine ────────────────────────────────────────────────────────────

  #beginCountdown() {
    this.#state          = STATE.COUNTDOWN;
    this.#countdownStart = performance.now();
    this.#startBtn.disabled   = true;
    this.#stateEl.textContent = 'get ready…';
  }

  #beginPlaying() {
    this.#state          = STATE.PLAYING;
    this.#score          = 0;
    this.#activeCloud    = null;
    this.#failedClouds   = [];
    this.#failAngleIndex = 0;
    this.#particles      = [];
    this.#phase          = 'inhale';
    this.#phaseStartTime = performance.now();
    this.#lastBreathMs   = -Infinity;
    this.#gameStartTime  = performance.now();

    this.#scoreEl.textContent  = '0';
    this.#stateEl.textContent  = 'playing';
    this.#startBtn.textContent = 'Restart';
    this.#startBtn.disabled    = false;
    this.#spawnCloud();
  }

  #endGame() {
    this.#state        = STATE.GAME_OVER;
    this.#activeCloud  = null;
    this.#failedClouds = [];
    this.#particles    = [];
    this.#stateEl.textContent  = 'game over';
    this.#startBtn.textContent = 'Play again';
    this.#startBtn.disabled    = false;
  }

  // ── Breath tracking ──────────────────────────────────────────────────────────

  #tickBreath(value, now, dt) {
    const norm  = value;
    const above = norm >= CONFIG.EXHALE_ONSET_THRESHOLD;
    this.#lastNorm = norm;

    if (this.#phase === 'inhale') {
      // Rising edge during inhale → exhale onset
      if (above && !this.#inBreath && now - this.#lastBreathMs > CONFIG.BREATH_DEBOUNCE_MS) {
        this.#onExhaleOnset(now);
      }
    } else {
      // Exhale phase: accumulate time above threshold
      if (above) this.#exhaleTimeAbove += dt;

      // Exhale phase ends after half a beat
      if (now - this.#phaseStartTime >= this.#beatMs / 2) {
        this.#onExhaleEnd(now);
      }
    }

    this.#inBreath = above;
  }

  #onExhaleOnset(now) {
    this.#phase           = 'exhale';
    this.#phaseStartTime  = now;
    this.#exhaleTimeAbove = 0;
    this.#lastBreathMs    = now;
  }

  #burstParticles(x, y) {
    for (let i = 0; i < 22; i++) this.#particles.push(new Particle(x, y));
  }

  #spawnCloud() {
    const cx = this.#canvas.width  / 2;
    const cy = this.#canvas.height / 2;
    const w  = this.#canvas.width;
    const h  = this.#canvas.height;
    const margin = 120;

    const edge = Math.floor(Math.random() * 4);
    const [sx, sy] = [
      [Math.random() * w,  -margin          ],
      [w + margin,          Math.random() * h],
      [Math.random() * w,   h + margin      ],
      [-margin,             Math.random() * h],
    ][edge];

    this.#activeCloud = new Cloud({ startX: sx, startY: sy, sunX: cx, sunY: cy });
  }

  #onExhaleEnd(now) {
    const exhalePhaseMs = this.#beatMs / 2;
    const ratio         = this.#exhaleTimeAbove / exhalePhaseMs;
    const success       = ratio >= CONFIG.EXHALE_SUCCESS_RATIO;

    if (this.#activeCloud) {
      if (success) {
        this.#score++;
        this.#scoreEl.textContent = this.#score;
        this.#activeCloud.succeed();
        this.#burstParticles(this.#activeCloud.x, this.#activeCloud.y);
        // gone cloud cleaned up in #update
      } else {
        const cx    = this.#canvas.width  / 2;
        const cy    = this.#canvas.height / 2;
        // Spread failed clouds evenly around the sun in up to 12 positions
        const angle = (this.#failAngleIndex * Math.PI * 2) / 12;
        const failX = cx + Math.cos(angle) * CONFIG.FAIL_ORBIT_R;
        const failY = cy + Math.sin(angle) * CONFIG.FAIL_ORBIT_R;
        this.#activeCloud.slideTo(failX, failY);
        this.#failedClouds.push(this.#activeCloud);
        this.#failAngleIndex = (this.#failAngleIndex + 1) % 12;
      }
      this.#activeCloud = null;
    }

    this.#phase          = 'inhale';
    this.#phaseStartTime = now;
    this.#spawnCloud();
  }

  // ── Game loop ────────────────────────────────────────────────────────────────

  #loop(timestamp) {
    const dt = this.#lastFrameTime != null ? timestamp - this.#lastFrameTime : 16;
    this.#lastFrameTime = timestamp;

    this.#syncCanvasSize();
    if (this.#state === STATE.PLAYING || this.#state === STATE.COUNTDOWN) this.#update(dt);
    this.#draw();
    requestAnimationFrame((t) => this.#loop(t));
  }

  #syncCanvasSize() {
    const c = this.#canvas;
    if (c.width !== c.offsetWidth || c.height !== c.offsetHeight) {
      c.width  = c.offsetWidth;
      c.height = c.offsetHeight;
    }
  }

  #update(dt) {
    const now = performance.now();

    if (this.#state === STATE.COUNTDOWN) {
      if (now - this.#countdownStart >= 3500) this.#beginPlaying();
      return;
    }

    if (now - this.#gameStartTime >= CONFIG.GAME_DURATION_SECS * 1000) {
      this.#endGame();
      return;
    }

    if (this.#activeCloud) this.#activeCloud.tick(dt);
    for (const c of this.#failedClouds) c.tick(dt);
    this.#failedClouds = this.#failedClouds.filter(c => c.alive);
    for (const p of this.#particles) p.tick(dt);
    this.#particles = this.#particles.filter(p => p.alive);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────

  #draw() {
    const ctx = this.#ctx;
    const w   = this.#canvas.width;
    const h   = this.#canvas.height;
    ctx.clearRect(0, 0, w, h);

    switch (this.#state) {
      case STATE.IDLE:      return this.#drawIdle(ctx, w, h);
      case STATE.COUNTDOWN: return this.#drawCountdown(ctx, w, h);
      case STATE.PLAYING:   return this.#drawPlaying(ctx, w, h);
      case STATE.GAME_OVER:   return this.#drawGameOver(ctx, w, h);
    }
  }

  #drawIdle(ctx, w, h) {
    ctx.fillStyle    = 'rgba(255,255,255,0.25)';
    ctx.font         = '300 20px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Select a stream and press Start', w / 2, h / 2);
  }

  #drawGameOver(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font      = '200 16px Nunito, sans-serif';
    ctx.fillText('SUCCESSFUL EXHALES', cx, cy - 52);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font      = '300 72px Nunito, sans-serif';
    ctx.fillText(this.#score, cx, cy);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font      = '200 14px Nunito, sans-serif';
    ctx.fillText('Press Play again to retry', cx, cy + 52);
  }

  #drawCountdown(ctx, w, h) {
    const elapsed = performance.now() - this.#countdownStart;
    const cx = w / 2, cy = h / 2;

    // Each digit occupies 1000 ms; "GO!" fills the last 500 ms
    let label;
    let phase; // 0–1 within the current step (for scale pulse)
    if (elapsed < 1000) {
      label = '3'; phase = elapsed / 1000;
    } else if (elapsed < 2000) {
      label = '2'; phase = (elapsed - 1000) / 1000;
    } else if (elapsed < 3000) {
      label = '1'; phase = (elapsed - 2000) / 1000;
    } else {
      label = 'GO!'; phase = (elapsed - 3000) / 500;
    }

    // Scale pulses large at step onset, settles to 1
    const scale = 1 + (1 - easeOut(phase)) * 0.5;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.fillStyle    = label === 'GO!' ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.font         = '300 80px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  #drawPlaying(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;

    // Sun (behind everything) — goes sad while covered
    const isCovered = this.#activeCloud?._state === 'covering';
    this.#drawSun(ctx, cx, cy, isCovered);

    // Failed clouds orbiting the sun
    for (const cloud of this.#failedClouds) {
      if (cloud.alive) this.#drawCloud(ctx, cloud.x, cloud.y, cloud.size, cloud.alpha);
    }

    // Active cloud — shake while the player is actively exhaling
    if (this.#activeCloud?.alive) {
      const shaking = this.#phase === 'exhale' && this.#inBreath;
      const t  = performance.now();
      const sx = shaking ? Math.sin(t / 38) * 6 : 0;
      const sy = shaking ? Math.cos(t / 31) * 5 : 0;
      this.#drawCloud(ctx, this.#activeCloud.x + sx, this.#activeCloud.y + sy, this.#activeCloud.size, this.#activeCloud.alpha);
    }

    // Particles (on top of everything)
    for (const p of this.#particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Debug breath-phase label
    const phaseLabel  = this.#phase === 'exhale' ? 'BREATHE OUT' : 'BREATHE IN';
    const signalLabel = this.#inBreath ? 'exhaling' : 'inhaling';
    const debug = `${phaseLabel}  |  signal: ${this.#lastNorm.toFixed(2)}  (${signalLabel})`;
    ctx.fillStyle    = 'rgba(255,255,255,0.55)';
    ctx.font         = '300 18px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(debug, cx, h - 20);
  }

  // ── Scene elements ────────────────────────────────────────────────────────────

  #drawSun(ctx, cx, cy, sad = false) {
    const r = CONFIG.SUN_RADIUS;

    // Rays
    const rayCount = 12;
    ctx.strokeStyle = 'rgba(255,210,50,0.85)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    for (let i = 0; i < rayCount; i++) {
      const angle = (i / rayCount) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r * 1.15, cy + Math.sin(angle) * r * 1.15);
      ctx.lineTo(cx + Math.cos(angle) * r * 1.50, cy + Math.sin(angle) * r * 1.50);
      ctx.stroke();
    }

    // Body
    const grd = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
    grd.addColorStop(0, '#fff7aa');
    grd.addColorStop(1, '#f5c000');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Eyes
    const eyeOffX = r * 0.28;
    const eyeOffY = r * 0.18;
    const eyeR    = r * 0.09;
    for (const ex of [-eyeOffX, eyeOffX]) {
      ctx.beginPath();
      ctx.arc(cx + ex, cy - eyeOffY, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = '#7a4a00';
      ctx.fill();
    }

    // Smile or frown
    ctx.beginPath();
    if (sad) {
      ctx.arc(cx, cy + r * 0.52, r * 0.32, 1.2 * Math.PI, 1.8 * Math.PI);
    } else {
      ctx.arc(cx, cy + r * 0.05, r * 0.38, 0.2 * Math.PI, 0.8 * Math.PI);
    }
    ctx.strokeStyle = '#7a4a00';
    ctx.lineWidth   = r * 0.08;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }

  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx:  0,            dy:  0,            r: size * 0.55 },
      { dx: -size * 0.42,  dy:  size * 0.12,  r: size * 0.42 },
      { dx:  size * 0.42,  dy:  size * 0.12,  r: size * 0.40 },
      { dx: -size * 0.20,  dy: -size * 0.28,  r: size * 0.34 },
      { dx:  size * 0.22,  dy: -size * 0.24,  r: size * 0.32 },
    ];

    const grd = ctx.createRadialGradient(x, y - size * 0.15, 0, x, y, size * 0.8);
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
}

export default Game;
