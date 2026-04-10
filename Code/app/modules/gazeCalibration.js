/**
 * gazeCalibration.js — WebGazer wrapper
 * ======================================
 * Key design decisions:
 *
 * 1. We do NOT call getUserMedia ourselves before WebGazer starts.
 *    The earlier #checkCamera() was releasing the stream track, which
 *    caused a brief camera-off period before WebGazer could re-open it.
 *
 * 2. webgazer.begin() is called at the START of the calibration UI, not
 *    after it. This means the face tracker is already running while the
 *    user clicks dots, so recordScreenPosition() actually trains the model
 *    with live eye data — which is required for predictions to work.
 *
 * 3. showVideoPreview(false) is called immediately after begin() so the
 *    WebGazer video/canvas elements are hidden from the start.
 */

const CLICKS_REQUIRED = 1;

const CALIB_POINTS = [
  [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
  [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
  [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
];

const DOT_RADIUS     = 10;
const DOT_COLOR      = 'rgba(255, 80, 80, 0.82)';
const DOT_RING_COLOR = 'rgba(255, 80, 80, 0.30)';
const DOT_RING_R     = 22;

export class GazeManager {
  #overlay      = null;
  #resolveCalib = null;
  #active       = false;
  #dotCanvas    = null;
  #dotCtx       = null;
  #dotVisible   = false;
  #dotRafId     = null;

  constructor() {
    window.gazeState = { x: 0, y: 0, active: false };
  }

  get isActive() { return this.#active; }

  // ── Public API ──────────────────────────────────────────────────────────────

  async runCalibration() {
    if (typeof webgazer === 'undefined') {
      console.error('[GazeManager] webgazer not defined — is lib/webgazer.js loaded?');
      return;
    }

    // Start WebGazer FIRST so the face tracker is live during calibration.
    // Training clicks only work when the camera is already running.
    try {
      console.log('[GazeManager] starting WebGazer before calibration…');

      webgazer.setGazeListener((data) => {
        if (!data) return;
        window.gazeState.x = data.x;
        window.gazeState.y = data.y;
      });

      await webgazer.begin();

      // Hide UI elements immediately — camera stays open
      webgazer.showVideoPreview(false);
      webgazer.showPredictionPoints(false);
      this.#hideWebGazerDOM();

      console.log('[GazeManager] WebGazer running, showing calibration UI');
    } catch (err) {
      console.error('[GazeManager] begin() failed:', err);
      await this.#showCameraError(err.message);
      return;
    }

    return new Promise((resolve) => {
      this.#resolveCalib = resolve;
      this.#showCalibrationUI();
    });
  }

  async start() {
    // WebGazer is already running after runCalibration().
    // Just activate gaze state and show the dot.
    if (this.#active) return;
    this.#active = true;
    window.gazeState.active = true;
    this.#showDot();
    console.log('[GazeManager] gaze tracking active');
  }

  stop() {
    if (!this.#active) return;
    if (typeof webgazer !== 'undefined') webgazer.pause();
    this.#active = false;
    window.gazeState.active = false;
    this.#hideDot();
  }

  // ── WebGazer DOM cleanup ────────────────────────────────────────────────────

  #hideWebGazerDOM() {
    const ids = [
      'webgazerVideoContainer', 'webgazerVideoFeed', 'webgazerVideoCanvas',
      'webgazerFaceOverlay', 'webgazerFaceFeedbackBox', 'webgazerGazeDot',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  }

  // ── Camera error UI ─────────────────────────────────────────────────────────

  #showCameraError(msg = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'gaze-calib-overlay';
      overlay.innerHTML = `
        <div id="gaze-calib-header">
          <h2>Camera Access Failed</h2>
          <p>
            Could not open the webcam.<br><br>
            <strong>Error:</strong> <code>${msg}</code><br><br>
            macOS: System Preferences → Privacy &amp; Security → Camera →
            enable <strong>Electron</strong>, then restart the app.
          </p>
        </div>
        <div id="gaze-calib-footer">
          <button id="gaze-calib-skip">Continue without gaze tracking</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#gaze-calib-skip').addEventListener('click', () => {
        overlay.remove();
        resolve();
      });
    });
  }

  // ── Calibration UI ──────────────────────────────────────────────────────────

  #showCalibrationUI() {
    const overlay = document.createElement('div');
    overlay.id = 'gaze-calib-overlay';
    overlay.innerHTML = `
      <div id="gaze-calib-header">
        <h2>Gaze Calibration</h2>
        <p>Click each dot while looking directly at it.
           All dots must turn green before continuing.</p>
      </div>
      <div id="gaze-calib-points"></div>
      <div id="gaze-calib-footer">
        <button id="gaze-calib-accept" disabled>Accept &amp; Continue</button>
        <button id="gaze-calib-skip">Skip (no gaze tracking)</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.#overlay = overlay;

    const container = overlay.querySelector('#gaze-calib-points');
    const dots = [];

    for (const [fx, fy] of CALIB_POINTS) {
      const dot = document.createElement('button');
      dot.className      = 'gaze-calib-dot';
      dot.dataset.clicks = '0';
      dot.style.left     = `${fx * 100}%`;
      dot.style.top      = `${fy * 100}%`;
      dot.addEventListener('click', () => this.#onDotClick(dot, dots, overlay));
      container.appendChild(dot);
      dots.push(dot);
    }

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

    // Record position with the LIVE face tracker — this is what trains the model
    const rect = dot.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    webgazer.recordScreenPosition(cx, cy, 'click');

    dot.style.setProperty('--calib-progress', Math.min(clicks / CLICKS_REQUIRED, 1));
    if (clicks >= CLICKS_REQUIRED) { dot.classList.add('done'); dot.disabled = true; }

    const allDone = allDots.every(d => parseInt(d.dataset.clicks) >= CLICKS_REQUIRED);
    overlay.querySelector('#gaze-calib-accept').disabled = !allDone;
  }

  #finishCalibration() {
    this.#overlay?.remove();
    this.#overlay = null;
    // Activate gaze state — WebGazer is already running
    this.start();
    this.#resolveCalib?.();
    this.#resolveCalib = null;
  }

  #skipCalibration() {
    this.#overlay?.remove();
    this.#overlay = null;
    // WebGazer is running but we won't mark it active or show the dot
    this.#resolveCalib?.();
    this.#resolveCalib = null;
  }

  // ── Gaze debug dot ──────────────────────────────────────────────────────────

  #showDot() {
    if (this.#dotVisible) return;
    if (!this.#dotCanvas) {
      const c = document.createElement('canvas');
      c.id = 'gaze-dot-canvas';
      document.body.appendChild(c);
      this.#dotCanvas = c;
      this.#dotCtx    = c.getContext('2d');
    }
    this.#dotCanvas.style.display = 'block';
    this.#dotVisible = true;
    this.#dotRafId = requestAnimationFrame(() => this.#drawDotLoop());
  }

  #hideDot() {
    if (!this.#dotVisible) return;
    this.#dotVisible = false;
    cancelAnimationFrame(this.#dotRafId);
    if (this.#dotCanvas) {
      this.#dotCanvas.style.display = 'none';
      this.#dotCtx.clearRect(0, 0, this.#dotCanvas.width, this.#dotCanvas.height);
    }
  }

  #drawDotLoop() {
    if (!this.#dotVisible) return;
    const canvas = this.#dotCanvas;
    const ctx    = this.#dotCtx;
    if (canvas.width  !== window.innerWidth)  canvas.width  = window.innerWidth;
    if (canvas.height !== window.innerHeight) canvas.height = window.innerHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { x, y, active } = window.gazeState;
    if (active && x !== 0 && y !== 0) {
      ctx.beginPath();
      ctx.arc(x, y, DOT_RING_R, 0, Math.PI * 2);
      ctx.strokeStyle = DOT_RING_COLOR; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOR; ctx.fill();
      ctx.strokeStyle = DOT_COLOR; ctx.lineWidth = 1.5;
      const arm = DOT_RING_R + 6;
      ctx.beginPath();
      ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
      ctx.stroke();
    }
    this.#dotRafId = requestAnimationFrame(() => this.#drawDotLoop());
  }
}