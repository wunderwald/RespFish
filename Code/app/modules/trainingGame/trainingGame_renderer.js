import { CONFIG, STATE } from './trainingGame_config.js';

function lerp(a, b, t) { return a + (b - a) * t; }
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

// ── Cloud ─────────────────────────────────────────────────────────────────────

export class Cloud {
  constructor({ startX, startY, sunX, sunY, slideInMs }) {
    this.x = startX;
    this.y = startY;
    this._fromX = startX;
    this._fromY = startY;
    this._toX = sunX;
    this._toY = sunY;
    this.sunX = sunX;
    this.sunY = sunY;
    this.size = CONFIG.CLOUD_SIZE;
    this.alpha = 1;
    this._state = 'sliding_in';
    this._t = 0;
    this._slideInMs = slideInMs;
  }

  get alive() { return this._state !== 'gone'; }

  succeed() { this._state = 'success_fade'; }

  slideTo(targetX, targetY) {
    this._state = 'sliding_out';
    this._t = 0;
    this._fromX = this.x;
    this._fromY = this.y;
    this._toX = targetX;
    this._toY = targetY;
  }

  tick(dt) {
    if (this._state === 'sliding_in') {
      this._t = Math.min(this._t + dt / this._slideInMs, 1);
      this.x = lerp(this._fromX, this._toX, easeOut(this._t));
      this.y = lerp(this._fromY, this._toY, easeOut(this._t));
      if (this._t >= 1) this._state = 'covering';

    } else if (this._state === 'success_fade') {
      this.alpha = Math.max(0, this.alpha - dt / 700);
      this.y -= dt * 0.06;
      if (this.alpha <= 0) this._state = 'gone';

    } else if (this._state === 'sliding_out') {
      this._t = Math.min(this._t + dt / CONFIG.CLOUD_SLIDE_MS, 1);
      this.x = lerp(this._fromX, this._toX, easeOut(this._t));
      this.y = lerp(this._fromY, this._toY, easeOut(this._t));
      if (this._t >= 1) this._state = 'resting';

    } else if (this._state === 'resting') {
      this.alpha = Math.max(0, this.alpha - dt / CONFIG.FAIL_FADE_MS);
      if (this.alpha <= 0) this._state = 'gone';
    }
  }
}

// ── Particle ──────────────────────────────────────────────────────────────────

const PARTICLE_COLORS = ['#ffffff', '#fff7aa', '#ffe066', '#ffffff', '#ffffff'];

export class Particle {
  constructor(x, y) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 140;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.r = 2.5 + Math.random() * 4;
    this.color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
    this.life = 450 + Math.random() * 300;
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

// ── TrainingGameRenderer ──────────────────────────────────────────────────────

export class TrainingGameRenderer {
  #canvas;
  #ctx;

  constructor(container) {
    container.innerHTML = '<canvas id="game-canvas"></canvas>';
    this.#canvas = container.querySelector('#game-canvas');
    this.#ctx = this.#canvas.getContext('2d');
  }

  get canvas() { return this.#canvas; }

  draw({ state, countdownElapsed, score, activeCloud, failedClouds, particles, phase, inBreath, now }) {
    const ctx = this.#ctx;
    const w = this.#canvas.width;
    const h = this.#canvas.height;
    ctx.clearRect(0, 0, w, h);

    switch (state) {
      case STATE.IDLE:      return this.#drawIdle(ctx, w, h);
      case STATE.COUNTDOWN: return this.#drawCountdown(ctx, w, h, countdownElapsed);
      case STATE.PLAYING:   return this.#drawPlaying(ctx, w, h, { activeCloud, failedClouds, particles, phase, inBreath, now });
      case STATE.GAME_OVER: return this.#drawGameOver(ctx, w, h, score);
    }
  }

  #drawIdle(ctx, w, h) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '300 20px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Select a stream and press Start', w / 2, h / 2);
  }

  #drawGameOver(ctx, w, h, score) {
    const cx = w / 2, cy = h / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '200 16px Nunito, sans-serif';
    ctx.fillText('SUCCESSFUL EXHALES', cx, cy - 52);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '300 72px Nunito, sans-serif';
    ctx.fillText(score, cx, cy);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '200 14px Nunito, sans-serif';
    ctx.fillText('Press Play again to retry', cx, cy + 52);
  }

  #drawCountdown(ctx, w, h, elapsed) {
    const cx = w / 2, cy = h / 2;

    let label, phase;
    if (elapsed < 1000)      { label = '3';   phase = elapsed / 1000; }
    else if (elapsed < 2000) { label = '2';   phase = (elapsed - 1000) / 1000; }
    else if (elapsed < 3000) { label = '1';   phase = (elapsed - 2000) / 1000; }
    else                     { label = 'GO!'; phase = (elapsed - 3000) / 500; }

    const scale = 1 + (1 - easeOut(phase)) * 0.5;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.fillStyle = label === 'GO!' ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.font = '300 80px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  #drawPlaying(ctx, w, h, { activeCloud, failedClouds, particles, phase, inBreath, now }) {
    const cx = w / 2;
    const cy = h / 2;

    const isCovered = activeCloud?._state === 'covering';
    this.#drawSun(ctx, cx, cy, isCovered);

    for (const cloud of failedClouds) {
      if (cloud.alive) this.#drawCloud(ctx, cloud.x, cloud.y, cloud.size, cloud.alpha);
    }

    if (activeCloud?.alive) {
      const shaking = phase === 'exhale' && inBreath;
      const sx = shaking ? Math.sin(now / 38) * 6 : 0;
      const sy = shaking ? Math.cos(now / 31) * 5 : 0;
      this.#drawCloud(ctx, activeCloud.x + sx, activeCloud.y + sy, activeCloud.size, activeCloud.alpha);
    }

    for (const p of particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  #drawSun(ctx, cx, cy, sad = false) {
    const r = CONFIG.SUN_RADIUS;

    ctx.strokeStyle = 'rgba(255,210,50,0.85)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r * 1.15, cy + Math.sin(angle) * r * 1.15);
      ctx.lineTo(cx + Math.cos(angle) * r * 1.50, cy + Math.sin(angle) * r * 1.50);
      ctx.stroke();
    }

    const grd = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
    grd.addColorStop(0, '#fff7aa');
    grd.addColorStop(1, '#f5c000');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    const eyeOffX = r * 0.28;
    const eyeOffY = r * 0.18;
    const eyeR = r * 0.09;
    for (const ex of [-eyeOffX, eyeOffX]) {
      ctx.beginPath();
      ctx.arc(cx + ex, cy - eyeOffY, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = '#7a4a00';
      ctx.fill();
    }

    ctx.beginPath();
    if (sad) {
      ctx.arc(cx, cy + r * 0.52, r * 0.32, 1.2 * Math.PI, 1.8 * Math.PI);
    } else {
      ctx.arc(cx, cy + r * 0.05, r * 0.38, 0.2 * Math.PI, 0.8 * Math.PI);
    }
    ctx.strokeStyle = '#7a4a00';
    ctx.lineWidth = r * 0.08;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx: 0,          dy: 0,          r: size * 0.55 },
      { dx: -size * 0.42, dy: size * 0.12, r: size * 0.42 },
      { dx:  size * 0.42, dy: size * 0.12, r: size * 0.40 },
      { dx: -size * 0.20, dy: -size * 0.28, r: size * 0.34 },
      { dx:  size * 0.22, dy: -size * 0.24, r: size * 0.32 },
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
