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
    this._seed = Math.random() * Math.PI * 2;
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
  #skyPatches;

  constructor(container) {
    container.innerHTML = '<canvas id="game-canvas"></canvas>';
    this.#canvas = container.querySelector('#game-canvas');
    this.#ctx = this.#canvas.getContext('2d');
    this.#skyPatches = Array.from({ length: 14 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.15 + Math.random() * 0.35,
      a: 0.04 + Math.random() * 0.07,
    }));
  }

  get canvas() { return this.#canvas; }

  draw({ state, countdownElapsed, score, gameElapsed, activeCloud, failedClouds, particles, phase, inBreath, exhaleProgress, heldSadness, now }) {
    const ctx = this.#ctx;
    const w = this.#canvas.width;
    const h = this.#canvas.height;

    let skyDarkness = 0;
    if (state === STATE.PLAYING) {
      skyDarkness += (activeCloud ? this.#cloudSadness(activeCloud, exhaleProgress) : heldSadness) * 0.45;
      for (const cloud of failedClouds) {
        if (cloud._state === 'sliding_out') {
          // mirror the mouth formula so sky and face change identically
          skyDarkness += (1 - (cloud._startExhaleProgress ?? 0)) * (1 - easeOut(cloud._t)) * 0.45;
        } else {
          skyDarkness += cloud.alpha * 0.20; // resting — permanent dimming, fades over a minute
        }
      }
      skyDarkness = Math.min(skyDarkness, 0.85);
    }
    this.#drawBackground(ctx, w, h, skyDarkness);

    switch (state) {
      case STATE.IDLE:      return this.#drawIdle(ctx, w, h);
      case STATE.COUNTDOWN: return this.#drawCountdown(ctx, w, h, countdownElapsed);
      case STATE.PLAYING:   return this.#drawPlaying(ctx, w, h, { activeCloud, failedClouds, particles, phase, inBreath, exhaleProgress, heldSadness, gameElapsed, score, now });
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
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur    = 8;
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';

    ctx.fillStyle = 'rgba(255,255,255,0.50)';
    ctx.font      = '200 16px Nunito, sans-serif';
    ctx.fillText('SUCCESSFUL EXHALES', cx, cy - 52);

    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.font      = '300 72px Nunito, sans-serif';
    ctx.fillText(score, cx, cy);

    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font      = '200 14px Nunito, sans-serif';
    ctx.fillText('Press Play again to retry', cx, cy + 52);
    ctx.restore();
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
    ctx.shadowColor   = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur    = 16;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.fillStyle     = label === 'GO!' ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.92)';
    ctx.font          = '300 80px Nunito, sans-serif';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  #cloudSadness(cloud, exhaleProgress = 0) {
    if (!cloud || !cloud.alive)          return 0;
    if (cloud._state === 'sliding_in')   return lerp(cloud._prevSadness ?? 0, 1, cloud._t);
    if (cloud._state === 'covering')     return 1 - exhaleProgress;
    if (cloud._state === 'success_fade') return cloud.alpha;
    if (cloud._state === 'sliding_out')  return (1 - (cloud._startExhaleProgress ?? 0)) * (1 - easeOut(cloud._t));
    return 0;
  }

  #drawPlaying(ctx, w, h, { activeCloud, failedClouds, particles, phase, inBreath, exhaleProgress, heldSadness, gameElapsed, score, now }) {
    const cx = w / 2;
    const cy = h / 2;

    const sunDx = Math.cos(now / 3200) * 4;
    const sunDy = Math.sin(now / 2200) * 5;
    const sadness = activeCloud ? this.#cloudSadness(activeCloud, exhaleProgress) : heldSadness;
    this.#drawSun(ctx, cx + sunDx, cy + sunDy, sadness);

    for (const cloud of failedClouds) {
      if (!cloud.alive) continue;
      const fx = Math.cos(now / 3800 + cloud._seed) * 3;
      const fy = Math.sin(now / 2500 + cloud._seed * 1.3) * 5;
      this.#drawCloud(ctx, cloud.x + fx, cloud.y + fy, cloud.size, cloud.alpha);
    }

    if (activeCloud?.alive) {
      const shaking = phase === 'exhale' && inBreath;
      const fx = shaking ? Math.sin(now / 38) * 6 : Math.cos(now / 3800 + activeCloud._seed) * 3;
      const fy = shaking ? Math.cos(now / 31) * 5 : Math.sin(now / 2500 + activeCloud._seed * 1.3) * 5;
      this.#drawCloud(ctx, activeCloud.x + fx, activeCloud.y + fy, activeCloud.size, activeCloud.alpha);
    }

    for (const p of particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.#drawScoreOverlay(ctx, score);
    this.#drawTimerBar(ctx, w, h, gameElapsed, now);
  }

  #drawBackground(ctx, w, h, darkness = 0) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0,   '#8bbfe0');
    sky.addColorStop(0.5, '#c2dff2');
    sky.addColorStop(1,   '#daeefa');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    for (const p of this.#skyPatches) {
      const px = p.x * w, py = p.y * h;
      const pr = p.r * Math.max(w, h);
      const grd = ctx.createRadialGradient(px, py, 0, px, py, pr);
      grd.addColorStop(0, `rgba(255,255,255,${p.a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }

    if (darkness > 0) {
      ctx.fillStyle = `rgba(20,35,70,${darkness * 0.6})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  #drawScoreOverlay(ctx, score) {
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur    = 10;
    ctx.textAlign     = 'left';
    ctx.textBaseline  = 'top';
    ctx.fillStyle     = 'rgba(255,255,255,0.88)';
    ctx.font          = '300 48px Nunito, sans-serif';
    ctx.fillText(score, 22, 14);
    ctx.fillStyle     = 'rgba(255,255,255,0.45)';
    ctx.font          = '200 13px Nunito, sans-serif';
    ctx.fillText('score', 24, 64);
    ctx.restore();
  }

  #drawTimerBar(ctx, w, h, gameElapsed, now) {
    const total    = CONFIG.GAME_DURATION_SECS;
    const timeLeft = Math.max(0, total - gameElapsed);
    const ratio    = Math.max(0, Math.min(1, timeLeft / total));

    const barMaxW  = Math.min(240, w * 0.25);
    const barH     = 9;
    const padRight = 20;
    const padTop   = 18;
    const barRight = w - padRight;
    const barY     = padTop;

    ctx.fillStyle = 'rgba(80,60,20,0.18)';
    ctx.beginPath();
    ctx.roundRect(barRight - barMaxW, barY, barMaxW, barH, 4);
    ctx.fill();

    const filledW = barMaxW * ratio;
    if (filledW > 2) {
      let barColor;
      if (timeLeft > 20) {
        barColor = 'rgba(80,60,20,0.55)';
      } else if (timeLeft > 8) {
        const t = (20 - timeLeft) / 12;
        barColor = `rgba(200,${Math.round(lerp(80, 40, t))},20,0.75)`;
      } else {
        const flash = 0.55 + 0.45 * Math.sin(now * 0.008);
        barColor = `rgba(220,50,30,${flash})`;
      }
      ctx.fillStyle = barColor;
      ctx.beginPath();
      ctx.roundRect(barRight - filledW, barY, filledW, barH, 4);
      ctx.fill();
    }

    const secs = Math.ceil(timeLeft);
    const mm   = String(Math.floor(secs / 60));
    const ss   = String(secs % 60).padStart(2, '0');
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur    = 6;
    ctx.fillStyle     = 'rgba(255,255,255,0.65)';
    ctx.font          = '300 12px Nunito, sans-serif';
    ctx.textAlign     = 'right';
    ctx.textBaseline  = 'top';
    ctx.fillText(`${mm}:${ss}`, barRight, barY + barH + 5);
    ctx.restore();
  }

  #drawSun(ctx, cx, cy, sadness = 0) {
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

    // Quadratic bezier mouth: control point bows down (smile) → flat → bows up (frown)
    const mW   = r * 0.38;
    const mY   = cy + r * 0.38;
    const bend = r * 0.35 * (1 - 2 * sadness);  // +r*0.35 = U, 0 = –, -r*0.35 = n
    ctx.beginPath();
    ctx.moveTo(cx - mW, mY);
    ctx.quadraticCurveTo(cx, mY + bend, cx + mW, mY);
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
