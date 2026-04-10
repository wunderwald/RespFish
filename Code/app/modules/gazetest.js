/**
 * gazetest.js — Gaze tracking test frontend
 * ==========================================
 * A minimal diagnostic frontend for verifying WebGazer is working correctly
 * before a real experiment session.
 *
 * What it shows:
 *   - A live gaze trail on a dark canvas (last N positions with fade)
 *   - A precision crosshair at the current gaze position
 *   - Four fixation targets at screen corners + centre to eyeball accuracy
 *   - A live accuracy readout: distance from nearest target while fixating
 *   - Status bar: gaze active/inactive, sample rate, last (x, y)
 *
 * Implements the standard frontend interface (stream events are ignored —
 * this frontend doesn't use respiration data):
 *   pushSample(value: number) → void   (no-op)
 *   setStatus({ type, text })  → void  (shows stream status only)
 *
 * To use: set FRONTEND = 'gazetest' in renderer.js
 */

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  TRAIL_LENGTH:      60,     // number of past gaze positions to render
  TRAIL_MIN_ALPHA:   0.03,
  TRAIL_MAX_ALPHA:   0.55,
  CROSSHAIR_SIZE:    18,     // px from centre to arm tip
  CROSSHAIR_RADIUS:  5,
  TARGET_RADIUS:     22,     // fixation target dot radius
  TARGET_HIT_RADIUS: 80,     // px — counts as "fixating" a target
  ACCURACY_WINDOW:   30,     // frames to average for accuracy readout
  SAMPLE_COUNTER_MS: 1000,   // update interval for samples/s display
};

// Fixation target positions as fractions of canvas [x, y, label]
const TARGETS = [
  [0.10, 0.12, 'TL'],
  [0.90, 0.12, 'TR'],
  [0.50, 0.50, 'C' ],
  [0.10, 0.88, 'BL'],
  [0.90, 0.88, 'BR'],
];

// ── GazeTest ──────────────────────────────────────────────────────────────────

export default class GazeTest {
  // trail ring buffer
  #trail    = [];             // [{ x, y }]
  #trailIdx = 0;

  // accuracy
  #accuracyBuf = [];          // recent distances to nearest target (px)

  // stats
  #sampleCount = 0;
  #samplesPerSec = 0;
  #lastSpsTime   = performance.now();

  // stream status (displayed in stats bar, not used for gaze)
  #streamStatus = 'waiting for stream…';

  // DOM
  #canvas = null;
  #ctx    = null;

  // stats bar elements
  #elGazeStatus = null;
  #elCoords     = null;
  #elSps        = null;
  #elAccuracy   = null;
  #elStream     = null;

  constructor({ statsContainer, sceneContainer }) {
    this.#buildStats(statsContainer);
    this.#buildScene(sceneContainer);

    // Pre-fill trail with off-screen positions
    for (let i = 0; i < CONFIG.TRAIL_LENGTH; i++) {
      this.#trail.push({ x: -999, y: -999 });
    }

    this.#startSpsCounter();
    requestAnimationFrame(() => this.#loop());
  }

  // ── Frontend interface ─────────────────────────────────────────────────────

  pushSample(_value) { /* not used */ }

  setStatus({ type, text }) {
    this.#streamStatus = text;
    if (this.#elStream) this.#elStream.textContent = text;
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  #buildStats(container) {
    container.innerHTML = `
      <span>
        <span class="label">gaze</span>
        <span id="gt-gaze-status">—</span>
      </span>
      <span>
        <span class="label">position</span>
        <span id="gt-coords">—</span>
      </span>
      <span>
        <span class="label">accuracy</span>
        <span id="gt-accuracy">—</span>
      </span>
      <span>
        <span class="label">samples/s</span>
        <span id="gt-sps">—</span>
      </span>
      <span>
        <span class="label">stream</span>
        <span id="gt-stream">waiting…</span>
      </span>
    `;
    this.#elGazeStatus = container.querySelector('#gt-gaze-status');
    this.#elCoords     = container.querySelector('#gt-coords');
    this.#elAccuracy   = container.querySelector('#gt-accuracy');
    this.#elSps        = container.querySelector('#gt-sps');
    this.#elStream     = container.querySelector('#gt-stream');
  }

  #buildScene(container) {
    container.innerHTML = '<canvas id="gt-canvas"></canvas>';
    this.#canvas = container.querySelector('#gt-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  #loop() {
    const canvas  = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const gs = window.gazeState ?? { x: 0, y: 0, active: false };

    if (gs.active && gs.x !== 0 && gs.y !== 0) {
      // Convert viewport coords → canvas-local coords
      const rect = canvas.getBoundingClientRect();
      const cx   = gs.x - rect.left;
      const cy   = gs.y - rect.top;

      // Append to trail
      this.#trail[this.#trailIdx % CONFIG.TRAIL_LENGTH] = { x: cx, y: cy };
      this.#trailIdx++;
      this.#sampleCount++;

      // Accuracy: distance to nearest fixation target
      const nearest = this.#nearestTarget(cx, cy, canvas.width, canvas.height);
      if (nearest.dist < CONFIG.TARGET_HIT_RADIUS) {
        this.#accuracyBuf.push(nearest.dist);
        if (this.#accuracyBuf.length > CONFIG.ACCURACY_WINDOW) {
          this.#accuracyBuf.shift();
        }
      }
    }

    this.#draw(gs, canvas.width, canvas.height);
    this.#updateStats(gs);

    requestAnimationFrame(() => this.#loop());
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  #draw(gs, w, h) {
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, w, h);

    this.#drawGrid(ctx, w, h);
    this.#drawTargets(ctx, w, h, gs);

    if (gs.active) {
      this.#drawTrail(ctx);
      this.#drawCrosshair(ctx, w, h, gs);
    } else {
      this.#drawInactiveHint(ctx, w, h);
    }
  }

  /** Subtle grid to make position easier to judge visually */
  #drawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    const cols = 10, rows = 6;
    for (let c = 1; c < cols; c++) {
      const x = (c / cols) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const y = (r / rows) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  /** Fixation targets */
  #drawTargets(ctx, w, h, gs) {
    const rect = this.#canvas.getBoundingClientRect();
    const cx   = (gs.x ?? 0) - rect.left;
    const cy   = (gs.y ?? 0) - rect.top;

    for (const [fx, fy, label] of TARGETS) {
      const tx = fx * w;
      const ty = fy * h;
      const dist = Math.hypot(cx - tx, cy - ty);
      const fixating = gs.active && dist < CONFIG.TARGET_HIT_RADIUS;

      // Hit zone ring (faint)
      ctx.beginPath();
      ctx.arc(tx, ty, CONFIG.TARGET_HIT_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = fixating
        ? 'rgba(91,201,138,0.18)'
        : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Target dot
      ctx.beginPath();
      ctx.arc(tx, ty, CONFIG.TARGET_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = fixating
        ? 'rgba(91,201,138,0.9)'
        : 'rgba(174,212,237,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Inner dot
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = fixating
        ? 'rgba(91,201,138,0.9)'
        : 'rgba(174,212,237,0.4)';
      ctx.fill();

      // Label
      ctx.fillStyle    = fixating
        ? 'rgba(91,201,138,0.8)'
        : 'rgba(174,212,237,0.25)';
      ctx.font         = '200 11px Nunito, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, tx, ty + CONFIG.TARGET_RADIUS + 6);

      // Accuracy readout when fixating
      if (fixating) {
        ctx.fillStyle    = 'rgba(91,201,138,0.7)';
        ctx.font         = '300 12px Nunito, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${Math.round(dist)} px`, tx, ty - CONFIG.TARGET_RADIUS - 4);
      }
    }
  }

  /** Fading gaze trail */
  #drawTrail(ctx) {
    const n = CONFIG.TRAIL_LENGTH;
    for (let i = 0; i < n; i++) {
      // Oldest first — index relative to current write head
      const age = (n - 1 - i);           // 0 = newest, n-1 = oldest
      const idx = (this.#trailIdx - 1 - age + n * 4) % n;
      const p   = this.#trail[idx];
      if (p.x < 0) continue;

      const frac  = i / (n - 1);         // 0 = oldest, 1 = newest
      const alpha = CONFIG.TRAIL_MIN_ALPHA +
                    frac * (CONFIG.TRAIL_MAX_ALPHA - CONFIG.TRAIL_MIN_ALPHA);
      const r     = 3 + frac * 5;        // dot grows toward current pos

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,100,100,${alpha.toFixed(3)})`;
      ctx.fill();
    }
  }

  /** Precision crosshair at current gaze point */
  #drawCrosshair(ctx, w, h, gs) {
    const rect = this.#canvas.getBoundingClientRect();
    const cx   = gs.x - rect.left;
    const cy   = gs.y - rect.top;
    if (cx < 0 || cy < 0 || cx > w || cy > h) return;

    const s = CONFIG.CROSSHAIR_SIZE;
    const r = CONFIG.CROSSHAIR_RADIUS;
    const gap = r + 4;

    ctx.strokeStyle = 'rgba(255,100,100,0.85)';
    ctx.lineWidth   = 1.5;

    // Horizontal arms
    ctx.beginPath();
    ctx.moveTo(cx - s, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + s,  cy);
    ctx.stroke();

    // Vertical arms
    ctx.beginPath();
    ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + s);
    ctx.stroke();

    // Centre circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,100,100,0.7)';
    ctx.stroke();

    // Coordinate readout beside crosshair
    ctx.fillStyle    = 'rgba(255,100,100,0.65)';
    ctx.font         = '200 11px Nunito, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    const label = `${Math.round(gs.x)}, ${Math.round(gs.y)}`;
    ctx.fillText(label, cx + s + 6, cy - 4);
  }

  /** Shown when gaze tracking is inactive */
  #drawInactiveHint(ctx, w, h) {
    ctx.fillStyle    = 'rgba(174,212,237,0.2)';
    ctx.font         = '200 16px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Gaze tracking inactive', w / 2, h / 2);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #nearestTarget(cx, cy, w, h) {
    let minDist = Infinity, minLabel = '';
    for (const [fx, fy, label] of TARGETS) {
      const dist = Math.hypot(cx - fx * w, cy - fy * h);
      if (dist < minDist) { minDist = dist; minLabel = label; }
    }
    return { dist: minDist, label: minLabel };
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────

  #startSpsCounter() {
    setInterval(() => {
      const now     = performance.now();
      const elapsed = now - this.#lastSpsTime;
      this.#samplesPerSec = Math.round(this.#sampleCount / elapsed * 1000);
      this.#sampleCount   = 0;
      this.#lastSpsTime   = now;
    }, CONFIG.SAMPLE_COUNTER_MS);
  }

  #updateStats(gs) {
    if (!this.#elGazeStatus) return;

    const active = gs?.active ?? false;
    this.#elGazeStatus.textContent  = active ? 'active' : 'inactive';
    this.#elGazeStatus.style.color  = active
      ? 'rgba(91,201,138,0.9)'
      : 'rgba(224,120,120,0.8)';

    if (active && gs.x) {
      this.#elCoords.textContent =
        `${Math.round(gs.x)}, ${Math.round(gs.y)}`;
    } else {
      this.#elCoords.textContent = '—';
    }

    const avgAcc = this.#accuracyBuf.length > 0
      ? this.#accuracyBuf.reduce((a, b) => a + b, 0) / this.#accuracyBuf.length
      : null;
    this.#elAccuracy.textContent = avgAcc !== null
      ? `${Math.round(avgAcc)} px`
      : '—';

    this.#elSps.textContent = active
      ? `${this.#samplesPerSec}`
      : '—';
  }
}