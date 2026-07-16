// Pure drawing layer for the iBreath experiment.
// Receives pre-computed state and data — no experiment logic here.

import { STATE, CONFIG } from './config.js';
import { drawDisplay } from './animationDisplay.js';
import { Caustics }    from './caustics.js';

export class IBreathRenderer {
  #canvas   = null;
  #ctx      = null;
  #images   = {};        // key → HTMLImageElement
  #caustics = null;

  constructor(container) {
    container.innerHTML = '<canvas id="ib-canvas"></canvas>';
    this.#canvas = container.querySelector('#ib-canvas');
    this.#ctx = this.#canvas.getContext('2d');
    for (const [key, src] of [['pufferfish', 'images/pufferfish.png'],
                               ['starfish',   'images/starfish.png'],
                               ['pinkfish',   'images/pinkfish.png']]) {
      const img = new Image();
      img.src = src;
      this.#images[key] = img;
    }
    this.#caustics = new Caustics();
  }

  // ── Public draw entry point ────────────────────────────────────────────

  draw(state, now, data = {}) {
    const canvas = this.#canvas;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const ctx = this.#ctx;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    this.#caustics.draw(ctx, w, h, now / 1000);

    switch (state) {
      case STATE.IDLE:        this.#drawIdle(ctx, w, h); break;
      case STATE.CALIBRATING: this.#drawCalibrating(ctx, w, h, data.calProgress, data.calRemaining); break;
      case STATE.READY:       this.#drawReady(ctx, w, h); break;
      case STATE.DISPLAY:     this.#drawDisplayState(ctx, w, h, data.displayElapsed); break;
      case STATE.TRIAL:       this.#drawTrial(ctx, w, h, data.trial, data.stimLevel, data.flashActive); break;
      case STATE.RESPONSE:    this.#drawResponse(ctx, w, h, now, data.responseStartTime, data.questionType); break;
      case STATE.ITI:         this.#drawITI(ctx, w, h, now, data.itiStartTime, data.itiDuration); break;
      case STATE.PAUSED:      this.#drawPaused(ctx, w, h, now); break;
      case STATE.DONE:        this.#drawDone(ctx, w, h, data.trialCount, data.subjectCode); break;
    }

    if (CONFIG.DEBUG_GAZE && data.gazeX != null && data.gazeY != null) {
      this.#drawGazeDot(ctx, w, h, data.gazeX, data.gazeY);
    }
  }

  #drawGazeDot(ctx, w, h, gx, gy) {
    const rect = this.#canvas.getBoundingClientRect();
    const x = gx * window.innerWidth  - rect.left;
    const y = gy * window.innerHeight - rect.top;
    const r = 10;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 80, 80, 0.75)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.restore();
  }

  // ── State draw methods ─────────────────────────────────────────────────

  #drawIdle(ctx, w, h) {
    this.#centerText(ctx, w / 2, h / 2, 'waiting for stream…', 'rgba(255,255,255,0.4)', 18);
  }

  #drawCalibrating(ctx, w, h, progress, remaining) {
    const cx = w / 2, cy = h / 2;
    const r = 60;

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '300 20px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Breathe normally…', cx, cy - 80);

    // Track ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();

    this.#centerText(ctx, cx, cy, String(remaining), 'rgba(255,255,255,0.7)', 52, '200');
  }

  #drawDisplayState(ctx, w, h, elapsed) {
    drawDisplay(ctx, w, h, elapsed, this.#images);
  }

  #drawReady(ctx, w, h) {
    this.#centerText(ctx, w / 2, h / 2,
      'Press Space or "Next trial" to begin',
      'rgba(255,255,255,0.35)', 18);
  }

  #drawTrial(ctx, w, h, trial, stimLevel, flashActive) {
    const halfW = w / 2;
    const centreX = trial.lr
      ? halfW / 2            // centre of left half
      : halfW + halfW / 2;   // centre of right half
    const centreY = h / 2;

    const minSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MIN;
    const maxSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MAX;
    const size = minSize + stimLevel * (maxSize - minSize);

    this.#drawStimImage(ctx, trial.img, centreX, centreY, size);

    if (flashActive) {
      const margin = 0.1;
      const fx = (margin + trial.flashX * (1 - 2 * margin)) * w;
      const fy = (margin + trial.flashY * (1 - 2 * margin)) * h;
      this.#drawFlash(ctx, fx, fy, trial.flashImage);
    }

    // Subtle dividing line between the two halves
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  #drawResponse(ctx, w, h, now, responseStartTime, questionType) {
    const elapsed   = now - responseStartTime;
    const timeout   = CONFIG.RESPONSE_TIMEOUT_SECS * 1000;
    const progress  = Math.min(elapsed / timeout, 1);
    const remaining = Math.max(0, Math.ceil(CONFIG.RESPONSE_TIMEOUT_SECS - elapsed / 1000));
    const cx = w / 2, cy = h / 2;
    const r  = 40;

    const QUESTIONS = {
      sync:  'Was the fish in sync with your breathing?',
      flash: 'Did you see the pink fish flashing?',
      lr:    'Was the fish left or right?',
      img:   'Did you see the pufferfish or the starfish?',
    };
    this.#centerText(ctx, cx, cy - 80, QUESTIONS[questionType] ?? QUESTIONS.sync,
                     'rgba(255,255,255,0.85)', 22);

    // For 'flash': small pinkfish image between question and arc
    if (questionType === 'flash') {
      const img = this.#images['pinkfish'];
      if (img?.complete && img.naturalWidth > 0) {
        const s = 22;
        ctx.drawImage(img, cx - s, cy - 56 - s, s * 2, s * 2);
      }
    }

    // Countdown arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 4;
    ctx.lineCap     = 'round';
    ctx.stroke();

    this.#centerText(ctx, cx, cy, String(remaining), 'rgba(255,255,255,0.7)', 36, '200');

    // Answer prompt — text or images depending on question type
    if (questionType === 'img') {
      const pf   = this.#images['pufferfish'];
      const sf   = this.#images['starfish'];
      const s    = 40;
      const gap  = Math.min(w, h) * 0.22;
      const imgY = cy + 90;
      if (pf?.complete && pf.naturalWidth > 0)
        ctx.drawImage(pf, cx - gap - s, imgY - s, s * 2, s * 2);
      if (sf?.complete && sf.naturalWidth > 0)
        ctx.drawImage(sf, cx + gap - s, imgY - s, s * 2, s * 2);
      this.#centerText(ctx, cx - gap, imgY + s + 10, '←', 'rgba(255,255,255,0.4)', 18);
      this.#centerText(ctx, cx + gap, imgY + s + 10, '→', 'rgba(255,255,255,0.4)', 18);
    } else if (questionType === 'lr') {
      this.#centerText(ctx, cx, cy + 80, '← left          right →', 'rgba(255,255,255,0.4)', 16);
    } else {
      this.#centerText(ctx, cx, cy + 80, '← yes          no →', 'rgba(255,255,255,0.4)', 16);
    }
  }

  #drawITI(ctx, w, h, now, itiStartTime, itiDuration) {
    const remaining = Math.max(0, itiDuration - (now - itiStartTime));
    const secs = (remaining / 1000).toFixed(1);
    this.#centerText(ctx, w / 2, h / 2,
      `Next trial in ${secs}s`, 'rgba(255,255,255,0.2)', 16);
  }

  #drawPaused(ctx, w, h, now) {
    const t    = now / 1000;
    const cx   = w / 2, cy = h / 2;
    const unit = Math.min(w, h);

    const swimHz  = 0.28;
    const phase   = t * swimHz * Math.PI * 2;

    // Lazy figure-8: x sweeps slowly, y wobbles at 2× frequency
    const x = cx + Math.sin(phase) * w * 0.28;
    const y = cy + Math.sin(phase * 2) * unit * 0.035;

    const facingLeft = Math.cos(phase) < 0;
    const wag        = Math.sin(phase * 2) * 0.10;
    const fishSize   = unit * 0.11;

    const img = this.#images['pinkfish'];
    ctx.save();
    ctx.translate(x, y);
    if (facingLeft) ctx.scale(-1, 1);
    ctx.rotate(wag);
    if (img?.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, -fishSize, -fishSize, fishSize * 2, fishSize * 2);
    }
    ctx.restore();

    this.#centerText(ctx, cx, cy + unit * 0.22, 'paused', 'rgba(255,255,255,0.28)', 16);
  }

  #drawDone(ctx, w, h, trialCount, subjectCode) {
    const cx = w / 2, cy = h / 2;
    this.#centerText(ctx, cx, cy - 40, 'Experiment complete', 'rgba(255,255,255,0.6)', 24);
    this.#centerText(ctx, cx, cy + 10, `${trialCount} trials recorded`, 'rgba(255,255,255,0.35)', 16);
    this.#centerText(ctx, cx, cy + 50, `Subject: ${subjectCode}`, 'rgba(255,255,255,0.25)', 14);
  }

  // ── Canvas helpers ─────────────────────────────────────────────────────

  // Draw a stimulus image centred at (cx, cy) with half-size `size`.
  // Falls back silently if the image hasn't loaded yet.
  #drawStimImage(ctx, key, cx, cy, size) {
    const img = this.#images[key];
    if (!img?.complete || img.naturalWidth === 0) return;
    ctx.drawImage(img, cx - size, cy - size, size * 2, size * 2);
  }

  // Draw a flash image centred at (x, y). Add cases here for new flash images.
  #drawFlash(ctx, x, y, image) {
    const img = this.#images[image];
    if (!img?.complete || img.naturalWidth === 0) return;
    const s = 72;
    ctx.drawImage(img, x - s, y - s, s * 2, s * 2);
  }

  // Procedural cloud — five overlapping circles with a white-to-light-blue
  // radial gradient. Ported from trainingGame.js #drawCloud.
  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx: 0, dy: 0, r: size * 0.55 },
      { dx: -size * 0.42, dy: size * 0.12, r: size * 0.42 },
      { dx: size * 0.42, dy: size * 0.12, r: size * 0.40 },
      { dx: -size * 0.20, dy: -size * 0.28, r: size * 0.34 },
      { dx: size * 0.22, dy: -size * 0.24, r: size * 0.32 },
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

  #centerText(ctx, x, y, text, color, size, weight = '300') {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }
}
