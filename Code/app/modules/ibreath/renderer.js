// Pure drawing layer for the iBreath experiment.
// Receives pre-computed state and data — no experiment logic here.

import { STATE, CONFIG } from './config.js';

export class IBreathRenderer {
  #canvas = null;
  #ctx    = null;

  constructor(container) {
    container.innerHTML = '<canvas id="ib-canvas"></canvas>';
    this.#canvas = container.querySelector('#ib-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── Public draw entry point ────────────────────────────────────────────

  draw(state, now, data = {}) {
    const canvas = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const ctx = this.#ctx;
    const w   = canvas.width;
    const h   = canvas.height;
    ctx.clearRect(0, 0, w, h);

    switch (state) {
      case STATE.IDLE:
        return this.#drawIdle(ctx, w, h);
      case STATE.CALIBRATING:
        return this.#drawCalibrating(ctx, w, h, now, data.calStartTime);
      case STATE.READY:
        return this.#drawReady(ctx, w, h);
      case STATE.TRIAL:
        return this.#drawTrial(ctx, w, h, data.trial, data.stimLevel);
      case STATE.ITI:
        return this.#drawITI(ctx, w, h, now, data.itiStartTime, data.itiDuration);
      case STATE.DONE:
        return this.#drawDone(ctx, w, h, data.trialCount, data.subjectCode);
    }
  }

  // ── State draw methods ─────────────────────────────────────────────────

  #drawIdle(ctx, w, h) {
    this.#centerText(ctx, w / 2, h / 2, 'waiting for stream…', 'rgba(255,255,255,0.4)', 18);
  }

  #drawCalibrating(ctx, w, h, now, calStartTime) {
    const elapsed   = now - calStartTime;
    const progress  = Math.min(elapsed / (CONFIG.CALIBRATION_SECS * 1000), 1);
    const remaining = Math.max(0, Math.ceil(CONFIG.CALIBRATION_SECS - elapsed / 1000));
    const cx = w / 2, cy = h / 2;
    const r  = 60;

    ctx.fillStyle    = 'rgba(255,255,255,0.85)';
    ctx.font         = '300 20px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Breathe normally…', cx, cy - 80);

    // Track ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 5;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();

    this.#centerText(ctx, cx, cy, String(remaining), 'rgba(255,255,255,0.7)', 52, '200');
  }

  #drawReady(ctx, w, h) {
    this.#centerText(ctx, w / 2, h / 2,
      'Press Space or "Next trial" to begin',
      'rgba(255,255,255,0.35)', 18);
  }

  #drawTrial(ctx, w, h, trial, stimLevel) {
    const halfW   = w / 2;
    const centreX = trial.lr
      ? halfW / 2            // centre of left half
      : halfW + halfW / 2;   // centre of right half
    const centreY = h / 2;

    const minSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MIN;
    const maxSize = Math.min(halfW, h) * CONFIG.CLOUD_SIZE_MAX;
    const size    = minSize + stimLevel * (maxSize - minSize);

    this.#drawCloud(ctx, centreX, centreY, size, 1);

    // Subtle dividing line between the two halves
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  #drawITI(ctx, w, h, now, itiStartTime, itiDuration) {
    const remaining = Math.max(0, itiDuration - (now - itiStartTime));
    const secs      = (remaining / 1000).toFixed(1);
    this.#centerText(ctx, w / 2, h / 2,
      `Next trial in ${secs}s`, 'rgba(255,255,255,0.2)', 16);
  }

  #drawDone(ctx, w, h, trialCount, subjectCode) {
    const cx = w / 2, cy = h / 2;
    this.#centerText(ctx, cx, cy - 40, 'Experiment complete',         'rgba(255,255,255,0.6)',  24);
    this.#centerText(ctx, cx, cy + 10, `${trialCount} trials recorded`, 'rgba(255,255,255,0.35)', 16);
    this.#centerText(ctx, cx, cy + 50, `Subject: ${subjectCode}`,     'rgba(255,255,255,0.25)', 14);
  }

  // ── Canvas helpers ─────────────────────────────────────────────────────

  // Procedural cloud — five overlapping circles with a white-to-light-blue
  // radial gradient. Ported from game.js #drawCloud.
  #drawCloud(ctx, x, y, size, alpha) {
    ctx.globalAlpha = alpha;

    const blobs = [
      { dx: 0,            dy: 0,            r: size * 0.55 },
      { dx: -size * 0.42, dy:  size * 0.12, r: size * 0.42 },
      { dx:  size * 0.42, dy:  size * 0.12, r: size * 0.40 },
      { dx: -size * 0.20, dy: -size * 0.28, r: size * 0.34 },
      { dx:  size * 0.22, dy: -size * 0.24, r: size * 0.32 },
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
    ctx.fillStyle    = color;
    ctx.font         = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }
}
