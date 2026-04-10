/**
 * gazeCalibration.js — WebGazer wrapper
 * ======================================
 * Manages the full gaze tracking lifecycle:
 *   1. 9-point calibration screen shown before the experiment starts.
 *   2. Exposes window.gazeState = { x, y, active } for any frontend to read.
 *   3. G-key macro toggles gaze tracking on/off at any time.
 *
 * Depends on WebGazer being loaded as a script before this module runs.
 * (Added to index.html in WP5.)
 *
 * Usage (renderer.js):
 *   import { GazeManager } from './modules/gazeCalibration.js';
 *   const gaze = new GazeManager();
 *   await gaze.runCalibration();   // resolves when calibration is accepted
 *   gaze.start();                  // begins streaming gaze to window.gazeState
 */

// ── Constants ─────────────────────────────────────────────────────────────────

// How many clicks each calibration point needs before it turns green
const CLICKS_REQUIRED = 5;

// Gaze debug dot
const DOT_RADIUS     = 10;
const DOT_COLOR      = 'rgba(255, 80, 80, 0.82)';
const DOT_RING_COLOR = 'rgba(255, 80, 80, 0.30)';
const DOT_RING_R     = 22;

// The 9 calibration points as [xFraction, yFraction] of the viewport
const CALIB_POINTS = [
  [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
  [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
  [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
];

// ── GazeManager ───────────────────────────────────────────────────────────────

export class GazeManager {
  #active          = false;
  #webgazerStarted = false;  // has webgazer.begin() ever been called?
  #overlay         = null;   // fullscreen calibration overlay element
  #resolveCalib    = null;   // resolve fn for the calibration promise

  // Gaze debug dot
  #dotCanvas = null;
  #dotCtx    = null;
  #dotVisible = false;
  #dotRafId   = null;

  constructor() {
    // Initialise global gaze state readable by any frontend
    window.gazeState = { x: 0, y: 0, active: false };
    // Note: G-key toggle removed intentionally.
    // Gaze is controlled programmatically via start() / stop() only.
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Shows the 9-point calibration UI.
   * Returns a Promise that resolves when the experimenter accepts calibration.
   * @returns {Promise<void>}
   */
  runCalibration() {
    return new Promise((resolve) => {
      this.#resolveCalib = resolve;
      this.#showCalibrationUI();
    });
  }

  /**
   * Starts the WebGazer listener and begins populating window.gazeState.
   * Safe to call multiple times — idempotent on the WebGazer side.
   */
  start() {
    if (typeof webgazer === 'undefined') {
      console.warn('[GazeManager] WebGazer not loaded — gaze tracking disabled');
      return;
    }

    // Always re-wire the listener so gazeState updates regardless of whether
    // WebGazer was paused, already running, or freshly started.
    webgazer.setGazeListener((data) => {
      if (!data) return;
      window.gazeState.x = data.x;
      window.gazeState.y = data.y;
    });

    if (!this.#webgazerStarted) {
      // First call — full initialisation
      webgazer.begin();
      this.#webgazerStarted = true;
    } else {
      // Subsequent calls — resume from paused state
      webgazer.resume();
    }

    // Always suppress built-in overlays (WebGazer re-shows them on resume)
    webgazer.showVideoPreview(false);
    webgazer.showPredictionPoints(false);

    this.#active = true;
    window.gazeState.active = true;
    this.#showDot();
    console.log('[GazeManager] gaze tracking started');
  }

  /**
   * Pauses the WebGazer listener (gaze state stops updating).
   */
  stop() {
    if (!this.#active) return;
    if (typeof webgazer !== 'undefined') webgazer.pause();
    this.#active = false;
    window.gazeState.active = false;
    this.#hideDot();
    console.log('[GazeManager] gaze tracking paused');
  }

  /** Whether gaze tracking is currently active. */
  get isActive() { return this.#active; }

  // ── Calibration UI ──────────────────────────────────────────────────────────

  #showCalibrationUI() {
    // Build fullscreen overlay
    const overlay = document.createElement('div');
    overlay.id = 'gaze-calib-overlay';
    overlay.innerHTML = `
      <div id="gaze-calib-header">
        <h2>Gaze Calibration</h2>
        <p>Click each dot <strong>${CLICKS_REQUIRED} times</strong> while
           looking directly at it. All dots must turn green before you can
           continue.</p>
      </div>
      <div id="gaze-calib-points"></div>
      <div id="gaze-calib-footer">
        <button id="gaze-calib-accept" disabled>Accept &amp; Continue</button>
        <button id="gaze-calib-skip">Skip (no gaze tracking)</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.#overlay = overlay;

    // Render calibration points
    const container = overlay.querySelector('#gaze-calib-points');
    const points    = [];

    for (const [fx, fy] of CALIB_POINTS) {
      const dot = document.createElement('button');
      dot.className  = 'gaze-calib-dot';
      dot.dataset.fx = fx;
      dot.dataset.fy = fy;
      dot.dataset.clicks = '0';

      // Position as % of viewport
      dot.style.left = `${fx * 100}%`;
      dot.style.top  = `${fy * 100}%`;

      dot.addEventListener('click', () => this.#onDotClick(dot, points, overlay));
      container.appendChild(dot);
      points.push(dot);
    }

    // Start WebGazer in background while calibration is shown
    this.#startWebGazerBackground();

    // Button handlers
    overlay.querySelector('#gaze-calib-accept').addEventListener('click', () => {
      this.#finishCalibration();
    });
    overlay.querySelector('#gaze-calib-skip').addEventListener('click', () => {
      this.#skipCalibration();
    });
  }

  #onDotClick(dot, allDots, overlay) {
    const clicks = parseInt(dot.dataset.clicks) + 1;
    dot.dataset.clicks = clicks;

    // Register click with WebGazer for training
    if (typeof webgazer !== 'undefined') {
      const rect = dot.getBoundingClientRect();
      const cx   = rect.left + rect.width  / 2;
      const cy   = rect.top  + rect.height / 2;
      webgazer.recordScreenPosition(cx, cy, 'click');
    }

    // Visual progress: fill the dot proportionally
    const progress = Math.min(clicks / CLICKS_REQUIRED, 1);
    dot.style.setProperty('--calib-progress', progress);

    if (clicks >= CLICKS_REQUIRED) {
      dot.classList.add('done');
      dot.disabled = true;
    }

    // Enable Accept once all dots are done
    const allDone = allDots.every(d => parseInt(d.dataset.clicks) >= CLICKS_REQUIRED);
    overlay.querySelector('#gaze-calib-accept').disabled = !allDone;
  }

  #startWebGazerBackground() {
    // During calibration we only need WebGazer to accept recordScreenPosition()
    // training clicks. We do NOT call begin() here — that belongs to start().
    // Instead, call begin() once now so the model trains during calibration,
    // and mark it started so start() knows to call resume() later.
    if (typeof webgazer === 'undefined') return;
    if (this.#webgazerStarted) return;
    try {
      webgazer.begin();
      webgazer.showVideoPreview(false);
      webgazer.showPredictionPoints(false);
      this.#webgazerStarted = true;
    } catch (e) {
      console.warn('[GazeManager] WebGazer failed to start during calibration:', e);
    }
  }

  #finishCalibration() {
    this.#overlay?.remove();
    this.#overlay = null;
    // WebGazer is already running from #startWebGazerBackground —
    // start() will call resume() rather than begin() again.
    this.start();
    this.#resolveCalib?.();
    this.#resolveCalib = null;
  }

  #skipCalibration() {
    if (typeof webgazer !== 'undefined') {
      try { webgazer.end(); } catch (_) { /* ignore */ }
    }
    this.#overlay?.remove();
    this.#overlay = null;
    window.gazeState.active = false;
    this.#resolveCalib?.();
    this.#resolveCalib = null;
    console.log('[GazeManager] calibration skipped — gaze tracking disabled');
  }

  // ── Gaze debug dot ──────────────────────────────────────────────────────────
  //
  // A small red crosshair dot drawn on a fullscreen canvas overlay, showing
  // exactly where WebGazer thinks the participant is looking.
  // Shown automatically when start() is called, hidden when stop() is called.

  #showDot() {
    if (this.#dotVisible) return;

    // Create or reuse the overlay canvas
    if (!this.#dotCanvas) {
      const canvas = document.createElement('canvas');
      canvas.id = 'gaze-dot-canvas';
      document.body.appendChild(canvas);
      this.#dotCanvas = canvas;
      this.#dotCtx    = canvas.getContext('2d');
    }

    this.#dotCanvas.style.display = 'block';
    this.#dotVisible = true;
    this.#dotRafId   = requestAnimationFrame(() => this.#drawDotLoop());
  }

  #hideDot() {
    if (!this.#dotVisible) return;
    this.#dotVisible = false;
    if (this.#dotRafId) {
      cancelAnimationFrame(this.#dotRafId);
      this.#dotRafId = null;
    }
    if (this.#dotCanvas) {
      this.#dotCanvas.style.display = 'none';
      // Clear any residual drawing
      this.#dotCtx.clearRect(0, 0, this.#dotCanvas.width, this.#dotCanvas.height);
    }
  }

  #drawDotLoop() {
    if (!this.#dotVisible) return;

    const canvas = this.#dotCanvas;
    const ctx    = this.#dotCtx;

    // Keep canvas sized to viewport
    if (canvas.width  !== window.innerWidth)  canvas.width  = window.innerWidth;
    if (canvas.height !== window.innerHeight) canvas.height = window.innerHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { x, y, active } = window.gazeState;
    if (active && x !== 0 && y !== 0) {
      // Outer ring
      ctx.beginPath();
      ctx.arc(x, y, DOT_RING_R, 0, Math.PI * 2);
      ctx.strokeStyle = DOT_RING_COLOR;
      ctx.lineWidth   = 2;
      ctx.stroke();

      // Inner filled dot
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOR;
      ctx.fill();

      // Crosshair lines
      ctx.strokeStyle = DOT_COLOR;
      ctx.lineWidth   = 1.5;
      const arm = DOT_RING_R + 6;
      ctx.beginPath();
      ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
      ctx.stroke();
    }

    this.#dotRafId = requestAnimationFrame(() => this.#drawDotLoop());
  }

}