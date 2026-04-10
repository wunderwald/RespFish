/**
 * gazeCalibration.js — WebGazer wrapper
 * ======================================
 * Key insight: WebGazer requires its internal <video> element to exist in the
 * DOM before it will open the camera. Calling showVideoPreview(false) before
 * begin() prevents the video element from being created, so getUserMedia is
 * never called and the camera light never turns on.
 *
 * Fix: let WebGazer create its video element freely (don't suppress it before
 * begin()), then hide it via CSS after the camera is running.
 */

const CLICKS_REQUIRED = 5;

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
  #calibPoints  = [];
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
    const camOk = await this.#checkCamera();
    if (!camOk) {
      await this.#showCameraError();
      return;
    }
    return new Promise((resolve) => {
      this.#resolveCalib = resolve;
      this.#showCalibrationUI();
    });
  }

  async start() {
    if (this.#active) return;
    if (typeof webgazer === 'undefined') {
      console.error('[GazeManager] webgazer not defined — is lib/webgazer.js loaded?');
      return;
    }
    try {
      console.log('[GazeManager] calling webgazer.begin()…');

      webgazer.setGazeListener((data) => {
        if (!data) return;
        window.gazeState.x = data.x;
        window.gazeState.y = data.y;
      });

      // Do NOT call showVideoPreview(false) before begin().
      // WebGazer needs to create its <video> element in the DOM
      // before getUserMedia will fire. We hide it via CSS instead.
      await webgazer.begin();

      console.log('[GazeManager] webgazer.begin() resolved');

      // Now it's safe to hide the preview — camera is already open
      webgazer.showVideoPreview(false);
      webgazer.showPredictionPoints(false);

      // Hide any residual WebGazer DOM elements that may still be visible
      this.#hideWebGazerDOM();

      // Replay calibration clicks
      for (const { x, y } of this.#calibPoints) {
        webgazer.recordScreenPosition(x, y, 'click');
      }

      this.#active = true;
      window.gazeState.active = true;
      this.#showDot();
      console.log('[GazeManager] active, replayed', this.#calibPoints.length, 'points');
    } catch (err) {
      console.error('[GazeManager] begin() failed:', err);
      this.#showErrorToast(`Gaze tracking failed: ${err.message}`);
    }
  }

  stop() {
    if (!this.#active) return;
    if (typeof webgazer !== 'undefined') webgazer.pause();
    this.#active = false;
    window.gazeState.active = false;
    this.#hideDot();
  }

  // ── Camera permission check ─────────────────────────────────────────────────

  async #checkCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      console.log('[GazeManager] camera access OK');
      return true;
    } catch (err) {
      console.error('[GazeManager] camera denied:', err.name, err.message);
      return false;
    }
  }

  // Hide WebGazer's own DOM elements (video, canvas overlays) without
  // stopping the camera. Must be called AFTER begin() resolves.
  #hideWebGazerDOM() {
    const ids = ['webgazerVideoFeed', 'webgazerVideoCanvas',
                 'webgazerFaceOverlay', 'webgazerFaceFeedbackBox'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // Also catch any elements WebGazer appended to body by class/tag
    document.querySelectorAll('video[id^="webgazer"]').forEach(el => {
      el.style.display = 'none';
    });
  }

  #showCameraError() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'gaze-calib-overlay';
      overlay.innerHTML = `
        <div id="gaze-calib-header">
          <h2>Camera Access Failed</h2>
          <p id="gaze-cam-msg">Requesting camera details…</p>
        </div>
        <div id="gaze-calib-footer">
          <button id="gaze-calib-skip">Continue without gaze tracking</button>
        </div>
      `;
      document.body.appendChild(overlay);
      navigator.mediaDevices.getUserMedia({ video: true }).catch(err => {
        const el = overlay.querySelector('#gaze-cam-msg');
        if (el) el.innerHTML = `
          Could not access the webcam.<br><br>
          <strong>Error:</strong> <code>${err.name}: ${err.message}</code><br><br>
          macOS: System Preferences → Privacy &amp; Security → Camera →
          enable <strong>Electron</strong>, then restart.
        `;
      });
      overlay.querySelector('#gaze-calib-skip').addEventListener('click', () => {
        overlay.remove();
        resolve();
      });
    });
  }

  #showErrorToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:rgba(180,50,50,0.92);color:#fff;padding:10px 24px;border-radius:8px;
      font-family:Nunito,sans-serif;font-size:0.82rem;z-index:9999;pointer-events:none`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 7000);
  }

  // ── Calibration UI ──────────────────────────────────────────────────────────

  #showCalibrationUI() {
    const overlay = document.createElement('div');
    overlay.id = 'gaze-calib-overlay';
    overlay.innerHTML = `
      <div id="gaze-calib-header">
        <h2>Gaze Calibration</h2>
        <p>Click each dot <strong>${CLICKS_REQUIRED} times</strong> while
           looking directly at it. All dots must turn green before continuing.</p>
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
    const rect = dot.getBoundingClientRect();
    this.#calibPoints.push({
      x: rect.left + rect.width  / 2,
      y: rect.top  + rect.height / 2,
    });
    dot.style.setProperty('--calib-progress', Math.min(clicks / CLICKS_REQUIRED, 1));
    if (clicks >= CLICKS_REQUIRED) { dot.classList.add('done'); dot.disabled = true; }
    const allDone = allDots.every(d => parseInt(d.dataset.clicks) >= CLICKS_REQUIRED);
    overlay.querySelector('#gaze-calib-accept').disabled = !allDone;
  }

  async #finishCalibration() {
    this.#overlay?.remove();
    this.#overlay = null;
    await this.start();
    this.#resolveCalib?.();
    this.#resolveCalib = null;
  }

  #skipCalibration() {
    this.#overlay?.remove();
    this.#overlay = null;
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