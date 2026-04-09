/**
 * game.js — Breath-controlled cloud game
 * =======================================
 * Guitar-Hero-style: clouds spawn at the screen edge and fly toward a center
 * ring along a squiggly path.  The player "blows them away" by exhaling
 * (signal entering the top fraction of the calibrated range) at the right
 * moment.  Score depends on timing accuracy.
 *
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 */

// ── Configuration ─────────────────────────────────────────────────────────────

export const CONFIG = {
  // Breathing rhythm
  TARGET_BPM:          15,      // target breaths per minute

  // Game duration
  GAME_DURATION_SECS:  60,     // seconds the playing phase lasts

  // Calibration
  CALIBRATION_SECS:    8,     // seconds of signal to record before playing
  BREATH_THRESHOLD:    0.40,   // normalised level that counts as an exhale
  BREATH_DEBOUNCE_MS:  1500,   // minimum ms between two breath triggers

  // Timing windows (ms from the perfect moment)
  TIMING: {
    PERFECT:    300,
    GOOD:       700,
    OK:         1200,
    MISS_GRACE: 600,   // auto-miss this many ms after the OK window closes
  },

  // Scoring
  SCORE: {
    PERFECT: 100,
    GOOD:    50,
    OK:      20,
  },

  // Cloud path
  TRAVEL_BEATS: 1,      // beats a cloud takes to reach the center ring
  CLOUD_SIZE:   70,     // base radius (px) — randomised ±20 % per cloud
  WIGGLE_AMP:   80,     // max perpendicular wiggle (px)
  WIGGLE_FREQ:  2.5,    // wiggle oscillations per trip

  // Center ring
  RING_RADIUS:    80,   // base radius (px)
  RING_PULSE_AMP: 0.15, // pulse amplitude as a fraction of RING_RADIUS
};

// ── Game states ───────────────────────────────────────────────────────────────

const STATE = {
  IDLE:        'idle',
  CALIBRATING: 'calibrating',
  PLAYING:     'playing',
  GAME_OVER:   'game_over',
};

// ── Cloud ─────────────────────────────────────────────────────────────────────

class Cloud {
  /**
   * @param {object} p
   * @param {number} p.startX      spawn x
   * @param {number} p.startY      spawn y
   * @param {number} p.cx          center x (target)
   * @param {number} p.cy          center y (target)
   * @param {number} p.arrivalTime ms timestamp when cloud should reach center
   * @param {number} p.travelMs    total travel time in ms
   */
  constructor({ startX, startY, cx, cy, arrivalTime, travelMs }) {
    this.startX      = startX;
    this.startY      = startY;
    this.cx          = cx;
    this.cy          = cy;
    this.arrivalTime = arrivalTime;
    this.spawnTime   = arrivalTime - travelMs;

    // Randomise path character per cloud
    this.wiggleAmp   = CONFIG.WIGGLE_AMP  * (0.6 + Math.random() * 0.8);
    this.wiggleFreq  = CONFIG.WIGGLE_FREQ * (0.7 + Math.random() * 0.6);
    this.wigglePhase = Math.random() * Math.PI * 2;
    this.size        = CONFIG.CLOUD_SIZE  * (0.8 + Math.random() * 0.4);

    this.state   = 'flying'; // flying | hit | missed | gone
    this.alpha   = 1;
    this.frozenT = null;     // set when the cloud is consumed to freeze position
  }

  /** Normalised progress t ∈ [0, 1+] at timestamp `now`. */
  tAt(now) {
    return (now - this.spawnTime) / (this.arrivalTime - this.spawnTime);
  }

  /**
   * World-space position for progress value `t`.
   * The path is a straight line with a perpendicular sinusoidal wiggle that
   * fades to zero as the cloud approaches the ring (smooth entry).
   */
  posAt(t) {
    const dx  = this.cx - this.startX;
    const dy  = this.cy - this.startY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    // Perpendicular unit vector
    const px = -dy / len;
    const py =  dx / len;

    // Wiggle envelope: quadratic fade-out near center
    const envelope = Math.pow(Math.max(0, 1 - t), 2);
    const wiggle   = Math.sin(t * this.wiggleFreq * Math.PI * 2 + this.wigglePhase)
                   * this.wiggleAmp * envelope;

    return {
      x: this.startX + dx * t + px * wiggle,
      y: this.startY + dy * t + py * wiggle,
    };
  }

  /** Position to use for drawing (respects frozen state). */
  drawPos(now) {
    const t = this.frozenT ?? Math.max(0, this.tAt(now));
    return this.posAt(t);
  }
}

// ── Feedback popup ────────────────────────────────────────────────────────────

class Feedback {
  constructor(text, color, x, y) {
    this.text  = text;
    this.color = color;
    this.x     = x;
    this.y     = y;
    this.alpha = 1;
  }

  tick() {
    this.alpha -= 0.018;
    this.y     -= 0.5;
  }

  get alive() { return this.alpha > 0; }
}

// ── Game ──────────────────────────────────────────────────────────────────────

export class Game {
  // state
  #state     = STATE.IDLE;
  #score     = 0;
  #clouds    = [];
  #feedbacks = [];

  // calibration
  #calStartTime = null;
  #calSamples   = [];
  #calRange     = null;  // { min, max }

  // breath detection
  #lastBreathMs = -Infinity;
  #inBreath     = false;

  // scheduling
  #beatMs        = (60 / CONFIG.TARGET_BPM) * 1000;
  #nextSpawnTime = null;
  #gameStartTime = null;

  // DOM
  #canvas   = null;
  #ctx      = null;
  #scoreEl  = null;
  #stateEl  = null;
  #startBtn = null;

  constructor({ statsContainer, sceneContainer }) {
    this.#buildHUD(statsContainer);
    this.#buildCanvas(sceneContainer);
    requestAnimationFrame(() => this.#loop());
  }

  // ── Frontend interface ─────────────────────────────────────────────────────

  pushSample(value) {
    if (this.#state === STATE.CALIBRATING) {
      this.#calSamples.push(value);
      this.#tickCalibration();
    } else if (this.#state === STATE.PLAYING && this.#calRange) {
      this.#tickBreath(value);
    }
  }

  setStatus({ type, text }) {
    const streamReady = type === 'connected';
    if (this.#state === STATE.IDLE) {
      this.#stateEl.textContent = streamReady ? 'ready — press Start' : text;
      this.#startBtn.disabled   = !streamReady;
    }
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  #buildHUD(container) {
    container.innerHTML = `
      <span id="game-state-text">waiting for stream…</span>
      <span><span class="label">score</span><span id="game-score">—</span></span>
      <button id="game-start-btn" disabled>Start</button>
    `;
    this.#stateEl  = container.querySelector('#game-state-text');
    this.#scoreEl  = container.querySelector('#game-score');
    this.#startBtn = container.querySelector('#game-start-btn');
    this.#startBtn.addEventListener('click', () => this.#beginCalibration());
  }

  #buildCanvas(container) {
    container.innerHTML = '<canvas id="game-canvas"></canvas>';
    this.#canvas = container.querySelector('#game-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── State machine ──────────────────────────────────────────────────────────

  #beginCalibration() {
    this.#state           = STATE.CALIBRATING;
    this.#calSamples      = [];
    this.#calRange        = null;
    this.#calStartTime    = performance.now();
    this.#startBtn.disabled    = true;
    this.#stateEl.textContent  = 'calibrating…';
  }

  #tickCalibration() {
    const elapsed = performance.now() - this.#calStartTime;
    if (elapsed < CONFIG.CALIBRATION_SECS * 1000) return;

    this.#calRange = {
      min: Math.min(...this.#calSamples),
      max: Math.max(...this.#calSamples),
    };
    this.#beginPlaying();
  }

  #beginPlaying() {
    this.#state            = STATE.PLAYING;
    this.#score            = 0;
    this.#clouds           = [];
    this.#feedbacks        = [];
    this.#lastBreathMs     = -Infinity;
    this.#gameStartTime    = performance.now();
    // First cloud spawns immediately and arrives one beat later
    this.#nextSpawnTime    = this.#gameStartTime;

    this.#scoreEl.textContent  = '0';
    this.#stateEl.textContent  = 'playing';
    this.#startBtn.textContent = 'Restart';
    this.#startBtn.disabled    = false;
  }

  #endGame() {
    this.#state = STATE.GAME_OVER;
    this.#clouds    = [];
    this.#feedbacks = [];
    this.#stateEl.textContent  = 'game over';
    this.#startBtn.textContent = 'Play again';
    this.#startBtn.disabled    = false;
  }

  // ── Breath detection ───────────────────────────────────────────────────────

  #tickBreath(value) {
    const { min, max } = this.#calRange;
    const norm = (value - min) / ((max - min) || 1);
    const above = norm >= CONFIG.BREATH_THRESHOLD;

    // Rising-edge: only trigger once per breath
    if (above && !this.#inBreath) {
      const now = performance.now();
      if (now - this.#lastBreathMs > CONFIG.BREATH_DEBOUNCE_MS) {
        this.#lastBreathMs = now;
        this.#onBreath(now);
      }
    }
    this.#inBreath = above;
  }

  #onBreath(now) {
    const cx = this.#canvas.width  / 2;
    const cy = this.#canvas.height / 2;

    // Pick the flying cloud whose arrival time is closest to now
    const target = this.#clouds
      .filter(c => c.state === 'flying')
      .sort((a, b) => Math.abs(now - a.arrivalTime) - Math.abs(now - b.arrivalTime))[0];

    if (!target) {
      this.#pushFeedback('TOO EARLY', '#f0c060', cx, cy);
      return;
    }

    const delta    = now - target.arrivalTime; // negative = early, positive = late
    const absDelta = Math.abs(delta);

    if (absDelta <= CONFIG.TIMING.PERFECT) {
      this.#award(target, now, 'PERFECT!', '#5bc98a', CONFIG.SCORE.PERFECT);
    } else if (absDelta <= CONFIG.TIMING.GOOD) {
      this.#award(target, now, 'GOOD', '#aed4ed', CONFIG.SCORE.GOOD);
    } else if (absDelta <= CONFIG.TIMING.OK) {
      this.#award(target, now, delta < 0 ? 'EARLY' : 'LATE', '#f0c060', CONFIG.SCORE.OK);
    } else {
      // Outside all timing windows — don't consume the cloud
      this.#pushFeedback(delta < 0 ? 'TOO EARLY' : 'TOO LATE', '#e07878', cx, cy);
    }
  }

  #award(cloud, now, label, color, points) {
    cloud.state   = 'hit';
    cloud.frozenT = Math.min(cloud.tAt(now), 1);
    this.#score  += points;
    this.#scoreEl.textContent = this.#score;
    this.#pushFeedback(
      `${label}  +${points}`, color,
      this.#canvas.width / 2, this.#canvas.height / 2,
    );
  }

  #pushFeedback(text, color, cx, cy) {
    this.#feedbacks.push(new Feedback(text, color, cx, cy - 80));
  }

  // ── Game loop ──────────────────────────────────────────────────────────────

  #loop() {
    this.#syncCanvasSize();
    if (this.#state === STATE.PLAYING) this.#update();
    this.#draw();
    requestAnimationFrame(() => this.#loop());
  }

  #syncCanvasSize() {
    const c = this.#canvas;
    if (c.width !== c.offsetWidth || c.height !== c.offsetHeight) {
      c.width  = c.offsetWidth;
      c.height = c.offsetHeight;
    }
  }

  #update() {
    const now = performance.now();
    const cx  = this.#canvas.width  / 2;
    const cy  = this.#canvas.height / 2;

    // ── Check game duration ─────────────────────────────────────────────────
    if (now - this.#gameStartTime >= CONFIG.GAME_DURATION_SECS * 1000) {
      this.#endGame();
      return;
    }

    // ── Spawn clouds ────────────────────────────────────────────────────────
    while (now >= this.#nextSpawnTime) {
      const arrivalTime   = this.#nextSpawnTime + this.#beatMs * CONFIG.TRAVEL_BEATS;
      this.#spawnCloud(cx, cy, arrivalTime);
      this.#nextSpawnTime += this.#beatMs;
    }

    // ── Cloud lifecycle ─────────────────────────────────────────────────────
    const missDeadline = CONFIG.TIMING.OK + CONFIG.TIMING.MISS_GRACE;

    for (const cloud of this.#clouds) {
      if (cloud.state === 'flying' && now > cloud.arrivalTime + missDeadline) {
        cloud.state   = 'missed';
        cloud.frozenT = cloud.tAt(now);
        this.#pushFeedback('MISS', '#e07878', cx, cy);
      }
      if (cloud.state === 'hit' || cloud.state === 'missed') {
        cloud.alpha = Math.max(0, cloud.alpha - 0.025);
        if (cloud.alpha === 0) cloud.state = 'gone';
      }
    }
    this.#clouds = this.#clouds.filter(c => c.state !== 'gone');

    // ── Feedbacks ───────────────────────────────────────────────────────────
    for (const f of this.#feedbacks) f.tick();
    this.#feedbacks = this.#feedbacks.filter(f => f.alive);
  }

  #spawnCloud(cx, cy, arrivalTime) {
    const w      = this.#canvas.width;
    const h      = this.#canvas.height;
    const margin = 100;

    // Random point on one of the four edges (outside the canvas)
    const edge = Math.floor(Math.random() * 4);
    const [startX, startY] = [
      [Math.random() * w, -margin    ],   // top
      [w + margin,        Math.random() * h],   // right
      [Math.random() * w, h + margin ],   // bottom
      [-margin,           Math.random() * h],   // left
    ][edge];

    this.#clouds.push(new Cloud({
      startX, startY, cx, cy,
      arrivalTime,
      travelMs: this.#beatMs * CONFIG.TRAVEL_BEATS,
    }));
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  #draw() {
    const ctx = this.#ctx;
    const w   = this.#canvas.width;
    const h   = this.#canvas.height;
    ctx.clearRect(0, 0, w, h);

    switch (this.#state) {
      case STATE.IDLE:        return this.#drawIdle(ctx, w, h);
      case STATE.CALIBRATING: return this.#drawCalibrating(ctx, w, h);
      case STATE.PLAYING:     return this.#drawPlaying(ctx, w, h);
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
    ctx.fillText('FINAL SCORE', cx, cy - 52);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font      = '300 72px Nunito, sans-serif';
    ctx.fillText(this.#score, cx, cy);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font      = '200 14px Nunito, sans-serif';
    ctx.fillText('Press Play again to retry', cx, cy + 52);
  }

  #drawCalibrating(ctx, w, h) {
    const elapsed  = performance.now() - this.#calStartTime;
    const progress = Math.min(elapsed / (CONFIG.CALIBRATION_SECS * 1000), 1);
    const remaining = Math.max(0, Math.ceil(CONFIG.CALIBRATION_SECS - elapsed / 1000));
    const cx = w / 2, cy = h / 2;

    // Instruction
    ctx.fillStyle    = 'rgba(255,255,255,0.85)';
    ctx.font         = '300 20px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Breathe normally…', cx, cy - 80);

    // Track ring (dim)
    ctx.beginPath();
    ctx.arc(cx, cy, 60, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 5;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, 60, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Countdown number
    ctx.fillStyle    = 'rgba(255,255,255,0.7)';
    ctx.font         = '200 52px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(remaining, cx, cy);
  }

  #drawPlaying(ctx, w, h) {
    const now = performance.now();
    const cx  = w / 2;
    const cy  = h / 2;

    // Breathing guide (drawn first, behind everything)
    this.#drawBreathGuide(ctx, cx, cy, now);

    // Clouds — furthest from center (lowest t) rendered first (behind)
    const now2 = now; // capture for sort closure
    [...this.#clouds]
      .sort((a, b) => a.tAt(now2) - b.tAt(now2))
      .forEach(cloud => {
        if (cloud.state === 'gone') return;
        const pos = cloud.drawPos(now);
        this.#drawCloud(ctx, pos.x, pos.y, cloud.size, cloud.alpha);
      });

    // Center ring (on top of clouds)
    this.#drawRing(ctx, cx, cy, now);

    // Feedback popups
    for (const f of this.#feedbacks) {
      ctx.globalAlpha  = f.alpha;
      ctx.fillStyle    = f.color;
      ctx.font         = 'bold 26px Nunito, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // ── Scene elements ─────────────────────────────────────────────────────────

  /**
   * A soft pulsing circle that guides the user's breathing rhythm.
   * Expands on inhale (0 → 0.5 of beat), contracts on exhale (0.5 → 1).
   * Clouds arrive at beat boundary (t = 0), which is the exhale peak.
   */
  #drawBreathGuide(ctx, cx, cy, now) {
    const beatPhase  = ((now - this.#gameStartTime) % this.#beatMs) / this.#beatMs;
    const breathNorm = Math.sin(beatPhase * Math.PI * 2) * 0.5 + 0.5; // 0→1→0
    const label      = beatPhase < 0.5 ? 'INHALE' : 'EXHALE';

    // Soft expanding/contracting circle
    const guideR = CONFIG.RING_RADIUS * (0.45 + breathNorm * 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, guideR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.03 + breathNorm * 0.07})`;
    ctx.fill();

    // Text label below the ring
    ctx.fillStyle    = `rgba(255,255,255,${0.2 + breathNorm * 0.25})`;
    ctx.font         = '200 12px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + CONFIG.RING_RADIUS + 22);
  }

  /**
   * The target ring in the center.  Pulses brightly at each beat boundary
   * (the moment a cloud should be hit).
   */
  #drawRing(ctx, cx, cy, now) {
    const beatPhase = ((now - this.#gameStartTime) % this.#beatMs) / this.#beatMs;
    // Sharp flash at beat boundary (phase ≈ 0)
    const flash = Math.exp(-beatPhase * 5);
    const r     = CONFIG.RING_RADIUS + flash * CONFIG.RING_RADIUS * CONFIG.RING_PULSE_AMP;

    // Soft radial glow
    const grd = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.7);
    grd.addColorStop(0, `rgba(255,255,255,${0.08 + flash * 0.12})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Ring stroke
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + flash * 0.45})`;
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Four cardinal tick marks
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(angle) * r,
        cy + Math.sin(angle) * r,
        3.5, 0, Math.PI * 2,
      );
      ctx.fillStyle = `rgba(255,255,255,${0.45 + flash * 0.3})`;
      ctx.fill();
    }
  }

  /**
   * Procedural cloud shape: five overlapping circles with a white-to-light-blue
   * radial gradient.  Replace with an image asset by swapping this method.
   */
  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx:  0,             dy:  0,            r: size * 0.55 },
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
