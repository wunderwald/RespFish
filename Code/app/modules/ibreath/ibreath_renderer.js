// Pure drawing layer for the iBreath experiment.
// Receives pre-computed state and data — no experiment logic here.

import { STATE, CONFIG } from './config.js';
import { drawDisplay } from './animationDisplay.js';

export class IBreathRenderer {
  #canvas = null;
  #ctx = null;

  constructor(container) {
    container.innerHTML = '<canvas id="ib-canvas"></canvas>';
    this.#canvas = container.querySelector('#ib-canvas');
    this.#ctx = this.#canvas.getContext('2d');
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

    switch (state) {
      case STATE.IDLE:        this.#drawIdle(ctx, w, h); break;
      case STATE.CALIBRATING: this.#drawCalibrating(ctx, w, h, now, data.calStartTime); break;
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

  #drawCalibrating(ctx, w, h, now, calStartTime) {
    const elapsed = now - calStartTime;
    const progress = Math.min(elapsed / (CONFIG.CALIBRATION_SECS * 1000), 1);
    const remaining = Math.max(0, Math.ceil(CONFIG.CALIBRATION_SECS - elapsed / 1000));
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
    drawDisplay(ctx, w, h, elapsed);
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

    this.#drawCloud(ctx, centreX, centreY, size, 1);

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

    const question = questionType === 'intero'
      ? 'Was the animation in sync with your breathing?'
      : 'Did you see a flashing image?';

    this.#centerText(ctx, cx, cy - 80, question, 'rgba(255,255,255,0.85)', 22);

    // Countdown arc (same style as calibration)
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

    this.#centerText(ctx, cx, cy + 80, '← yes          no →', 'rgba(255,255,255,0.4)', 16);
  }

  #drawITI(ctx, w, h, now, itiStartTime, itiDuration) {
    const remaining = Math.max(0, itiDuration - (now - itiStartTime));
    const secs = (remaining / 1000).toFixed(1);
    this.#centerText(ctx, w / 2, h / 2,
      `Next trial in ${secs}s`, 'rgba(255,255,255,0.2)', 16);
  }

  #drawPaused(ctx, w, h, now) {
    const cx = w / 2, cy = h / 2;
    const r  = Math.min(w, h) * 0.12;

    // Soft warm glow behind sun
    const grd = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.8);
    grd.addColorStop(0, 'rgba(255, 215, 60, 0.14)');
    grd.addColorStop(1, 'rgba(255, 180, 0, 0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    // Slowly rotating rays
    const numRays   = 8;
    const rotSpeed  = now * 0.00015;
    const rayInner  = r * 1.3;
    const rayOuter  = r * 1.75;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 210, 60, 0.55)';
    ctx.lineWidth   = r * 0.09;
    ctx.lineCap     = 'round';
    for (let i = 0; i < numRays; i++) {
      const a = rotSpeed + (i / numRays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rayInner, cy + Math.sin(a) * rayInner);
      ctx.lineTo(cx + Math.cos(a) * rayOuter, cy + Math.sin(a) * rayOuter);
      ctx.stroke();
    }
    ctx.restore();

    // Sun body
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 215, 55, 0.92)';
    ctx.fill();

    // Eyes
    const eyeR = r * 0.1;
    const eyeY = cy - r * 0.18;
    ctx.fillStyle = 'rgba(80, 50, 0, 0.85)';
    ctx.beginPath(); ctx.arc(cx - r * 0.3, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.3, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();

    // Smile
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.08, r * 0.44, 0.25, Math.PI - 0.25);
    ctx.strokeStyle = 'rgba(80, 50, 0, 0.85)';
    ctx.lineWidth   = r * 0.1;
    ctx.lineCap     = 'round';
    ctx.stroke();

    this.#centerText(ctx, cx, cy + r * 2.2, 'paused', 'rgba(255,255,255,0.28)', 16);
  }

  #drawDone(ctx, w, h, trialCount, subjectCode) {
    const cx = w / 2, cy = h / 2;
    this.#centerText(ctx, cx, cy - 40, 'Experiment complete', 'rgba(255,255,255,0.6)', 24);
    this.#centerText(ctx, cx, cy + 10, `${trialCount} trials recorded`, 'rgba(255,255,255,0.35)', 16);
    this.#centerText(ctx, cx, cy + 50, `Subject: ${subjectCode}`, 'rgba(255,255,255,0.25)', 14);
  }

  // ── Canvas helpers ─────────────────────────────────────────────────────

  // Dispatcher — add cases here when new flash images are introduced.
  #drawFlash(ctx, x, y, image) {
    if (image === 'lightning') this.#drawLightning(ctx, x, y);
  }

  #drawLightning(ctx, x, y) {
    const s = 72;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 240, 80, 1)';
    ctx.shadowColor = 'rgba(255, 220, 50, 0.9)';
    ctx.shadowBlur = 30;

    // Classic 6-point bolt polygon
    ctx.beginPath();
    ctx.moveTo(x + s * 0.10, y - s * 0.50);  // top
    ctx.lineTo(x - s * 0.22, y + s * 0.08);  // upper-left
    ctx.lineTo(x + s * 0.04, y + s * 0.08);  // inner knee
    ctx.lineTo(x - s * 0.10, y + s * 0.50);  // bottom
    ctx.lineTo(x + s * 0.22, y - s * 0.08);  // lower-right
    ctx.lineTo(x - s * 0.04, y - s * 0.08);  // inner knee
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
