/**
 * gazeCalibration.js — WebGazer wrapper
 * ======================================
 * EyeLink-style sequential calibration + validation:
 *
 * Phase 1 — CALIBRATION
 *   Points appear one at a time with a pulsing animation.
 *   Experimenter presses Space (or clicks the point) to record & advance.
 *   WebGazer is already running so each click trains the model live.
 *
 * Phase 2 — VALIDATION
 *   Same 9 points in random order. For each, we collect ~30 gaze samples
 *   while the point pulses, compute mean distance, show per-point error.
 *   Experimenter can Accept or Recalibrate (restarts from Phase 1).
 *
 * Public API:
 *   const gaze = new GazeManager();
 *   await gaze.runCalibration();   // resolves after Accept or Skip
 *   gaze.isActive                  // true if tracking
 *   gaze.stop()
 */

// ── Config ────────────────────────────────────────────────────────────────────

// Grid positions as [xFraction, yFraction]
const CALIB_POINTS = [
  [0.5, 0.5],                               // centre first (easiest to find)
  [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],      // top row
  [0.1, 0.5],             [0.9, 0.5],       // middle sides
  [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],      // bottom row
];

const VALIDATION_SAMPLES   = 30;   // gaze samples to collect per validation point
const VALIDATION_SAMPLE_MS = 50;   // ms between samples (~20 Hz)
const GOOD_ACCURACY_PX     = 80;   // px mean error considered acceptable (green)
const OK_ACCURACY_PX       = 140;  // px mean error considered marginal (yellow)

// Gaze debug dot appearance
const DOT_RADIUS     = 10;
const DOT_COLOR      = 'rgba(255, 80, 80, 0.82)';
const DOT_RING_COLOR = 'rgba(255, 80, 80, 0.30)';
const DOT_RING_R     = 22;

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── GazeManager ───────────────────────────────────────────────────────────────

export class GazeManager {
  #active       = false;
  #resolveCalib = null;

  // Gaze debug dot
  #dotCanvas  = null;
  #dotCtx     = null;
  #dotVisible = false;
  #dotRafId   = null;

  constructor() {
    window.gazeState = { x: 0, y: 0, active: false };
  }

  get isActive() { return this.#active; }

  // ── Public API ──────────────────────────────────────────────────────────────

  async runCalibration() {
    if (typeof webgazer === 'undefined') {
      console.error('[GazeManager] webgazer not defined');
      return;
    }

    // Start WebGazer first — face tracker must be live for training clicks
    try {
      webgazer.setGazeListener((data) => {
        if (!data) return;
        window.gazeState.x = data.x;
        window.gazeState.y = data.y;
      });
      await webgazer.begin();
      webgazer.showVideoPreview(false);
      webgazer.showPredictionPoints(false);
      this.#hideWebGazerDOM();
      console.log('[GazeManager] WebGazer running');
    } catch (err) {
      console.error('[GazeManager] begin() failed:', err);
      await this.#showCameraError(err.message);
      return;
    }

    // Run calibration → validation loop (recalibrate restarts both)
    while (true) {
      await this.#runCalibrationPhase();
      const accepted = await this.#runValidationPhase();
      if (accepted) break;
      // Recalibrate: clear WebGazer data and go again
      await webgazer.clearData();
    }

    this.#active = true;
    window.gazeState.active = true;
    this.#showDot();
  }

  stop() {
    if (!this.#active) return;
    if (typeof webgazer !== 'undefined') webgazer.pause();
    this.#active = false;
    window.gazeState.active = false;
    this.#hideDot();
  }

  // ── Phase 1: Calibration ────────────────────────────────────────────────────

  #runCalibrationPhase() {
    return new Promise((resolve) => {
      const overlay = this.#makeOverlay();
      const canvas  = this.#makeCanvas(overlay);
      const ctx     = canvas.getContext('2d');

      // Header
      const header = document.createElement('div');
      header.id = 'gaze-calib-header';
      header.innerHTML = `
        <h2>Gaze Calibration</h2>
        <p>Look at each dot and press <strong>Space</strong> or click it to record.</p>
      `;
      overlay.appendChild(header);

      // Progress label
      const progress = document.createElement('div');
      progress.id = 'gaze-calib-progress';
      overlay.appendChild(progress);

      // Skip button
      const skipBtn = document.createElement('div');
      skipBtn.id = 'gaze-calib-footer';
      skipBtn.innerHTML = `<button id="gaze-calib-skip">Skip calibration</button>`;
      overlay.appendChild(skipBtn);

      document.body.appendChild(overlay);

      let pointIdx = 0;
      let animT    = 0;
      let rafId    = null;

      const advance = () => {
        if (pointIdx >= CALIB_POINTS.length) {
          cancelAnimationFrame(rafId);
          overlay.remove();
          resolve();
          return;
        }

        const [fx, fy] = CALIB_POINTS[pointIdx];
        const px = fx * window.innerWidth;
        const py = fy * window.innerHeight;

        progress.textContent = `${pointIdx + 1} / ${CALIB_POINTS.length}`;

        // Record click with live face tracker
        webgazer.recordScreenPosition(px, py, 'click');

        pointIdx++;
        animT = 0;
      };

      // Keyboard handler
      const onKey = (e) => {
        if (e.code === 'Space') { e.preventDefault(); advance(); }
      };
      window.addEventListener('keydown', onKey);

      // Click handler on canvas
      canvas.addEventListener('click', advance);

      // Animation loop
      const draw = () => {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (pointIdx >= CALIB_POINTS.length) return;

        const [fx, fy] = CALIB_POINTS[pointIdx];
        const px = fx * canvas.width;
        const py = fy * canvas.height;

        animT += 0.04;
        const pulse = 1 + 0.18 * Math.sin(animT * Math.PI * 2);

        // Outer ring
        ctx.beginPath();
        ctx.arc(px, py, 28 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(174,212,237,0.25)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner fill
        ctx.beginPath();
        ctx.arc(px, py, 14 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(174,212,237,0.9)';
        ctx.fill();

        // Centre dot
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#0f485f';
        ctx.fill();

        // Completed points (dim)
        for (let i = 0; i < pointIdx; i++) {
          const [fx2, fy2] = CALIB_POINTS[i];
          ctx.beginPath();
          ctx.arc(fx2 * canvas.width, fy2 * canvas.height, 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(91,201,138,0.5)';
          ctx.fill();
        }

        rafId = requestAnimationFrame(draw);
      };

      // Cleanup on skip
      skipBtn.querySelector('#gaze-calib-skip').addEventListener('click', () => {
        window.removeEventListener('keydown', onKey);
        cancelAnimationFrame(rafId);
        overlay.remove();
        resolve();
      });

      draw();
    });
  }

  // ── Phase 2: Validation ─────────────────────────────────────────────────────

  #runValidationPhase() {
    return new Promise(async (resolve) => {
      const overlay = this.#makeOverlay();
      const canvas  = this.#makeCanvas(overlay);
      const ctx     = canvas.getContext('2d');

      const header = document.createElement('div');
      header.id = 'gaze-calib-header';
      header.innerHTML = `
        <h2>Validation</h2>
        <p>Look at each dot while it pulses. Do not click.</p>
      `;
      overlay.appendChild(header);

      const progress = document.createElement('div');
      progress.id = 'gaze-calib-progress';
      overlay.appendChild(progress);

      document.body.appendChild(overlay);

      const order   = shuffle([...Array(CALIB_POINTS.length).keys()]);
      const errors  = new Array(CALIB_POINTS.length).fill(null);

      for (let i = 0; i < order.length; i++) {
        const ptIdx  = order[i];
        const [fx, fy] = CALIB_POINTS[ptIdx];
        const px     = fx * window.innerWidth;
        const py     = fy * window.innerHeight;

        progress.textContent = `${i + 1} / ${order.length}`;

        // Animate the point while collecting samples
        let animT  = 0;
        let done   = false;
        let rafId  = null;

        const draw = () => {
          canvas.width  = window.innerWidth;
          canvas.height = window.innerHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          animT += 0.04;
          const pulse = 1 + 0.22 * Math.sin(animT * Math.PI * 2);

          // Outer ring
          ctx.beginPath();
          ctx.arc(px, py, 28 * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,200,80,0.3)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Inner fill (yellow during validation)
          ctx.beginPath();
          ctx.arc(px, py, 14 * pulse, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,200,80,0.9)';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#0f485f';
          ctx.fill();

          if (!done) rafId = requestAnimationFrame(draw);
        };
        rafId = requestAnimationFrame(draw);

        // Collect gaze samples
        const samples = [];
        for (let s = 0; s < VALIDATION_SAMPLES; s++) {
          await sleep(VALIDATION_SAMPLE_MS);
          const { x, y } = window.gazeState;
          if (x !== 0 || y !== 0) {
            samples.push(Math.hypot(x - px, y - py));
          }
        }

        done = true;
        cancelAnimationFrame(rafId);

        errors[ptIdx] = samples.length > 0
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : null;
      }

      // Show results
      this.#drawValidationResults(ctx, canvas, errors, overlay, resolve);
    });
  }

  #drawValidationResults(ctx, canvas, errors, overlay, resolve) {
    // Update header
    overlay.querySelector('#gaze-calib-header').innerHTML = `
      <h2>Validation Results</h2>
      <p>Mean error per point. Green &lt; ${GOOD_ACCURACY_PX}px · Yellow &lt; ${OK_ACCURACY_PX}px · Red = poor.</p>
    `;
    overlay.querySelector('#gaze-calib-progress').textContent = '';

    // Overall mean
    const valid = errors.filter(e => e !== null);
    const mean  = valid.length
      ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
      : null;

    // Footer buttons
    const footer = document.createElement('div');
    footer.id = 'gaze-calib-footer';
    footer.innerHTML = `
      <button id="gaze-calib-accept">Accept &amp; Continue</button>
      <button id="gaze-calib-skip">Recalibrate</button>
    `;
    overlay.appendChild(footer);

    // Overall accuracy badge
    const badge = document.createElement('div');
    badge.id = 'gaze-val-badge';
    const color = mean === null ? '#aed4ed'
      : mean < GOOD_ACCURACY_PX ? '#5bc98a'
      : mean < OK_ACCURACY_PX   ? '#f0c060'
      :                           '#e07878';
    badge.innerHTML = mean !== null
      ? `<span style="color:${color}">Mean error: <strong>${mean} px</strong></span>`
      : `<span style="color:#e07878">No data collected</span>`;
    overlay.insertBefore(badge, footer);

    // Draw points with error colours on canvas
    const draw = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < CALIB_POINTS.length; i++) {
        const [fx, fy] = CALIB_POINTS[i];
        const px = fx * canvas.width;
        const py = fy * canvas.height;
        const err = errors[i];

        const col = err === null  ? 'rgba(174,212,237,0.3)'
          : err < GOOD_ACCURACY_PX ? 'rgba(91,201,138,0.9)'
          : err < OK_ACCURACY_PX   ? 'rgba(240,192,96,0.9)'
          :                          'rgba(224,120,120,0.9)';

        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#0f485f';
        ctx.fill();

        if (err !== null) {
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.font = '200 11px Nunito, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(`${Math.round(err)}px`, px, py + 18);
        }
      }
    };
    draw();

    footer.querySelector('#gaze-calib-accept').addEventListener('click', () => {
      overlay.remove();
      resolve(true);   // accepted
    });
    footer.querySelector('#gaze-calib-skip').addEventListener('click', () => {
      overlay.remove();
      resolve(false);  // recalibrate
    });
  }

  // ── Shared UI helpers ───────────────────────────────────────────────────────

  #makeOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'gaze-calib-overlay';
    return overlay;
  }

  #makeCanvas(overlay) {
    const canvas = document.createElement('canvas');
    canvas.id = 'gaze-calib-canvas';
    overlay.appendChild(canvas);
    return canvas;
  }

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

  #showCameraError(msg = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'gaze-calib-overlay';
      overlay.innerHTML = `
        <div id="gaze-calib-header">
          <h2>Camera Access Failed</h2>
          <p>Could not open the webcam.<br><br>
             <strong>Error:</strong> <code>${msg}</code><br><br>
             macOS: System Preferences → Privacy &amp; Security → Camera →
             enable <strong>Electron</strong>, then restart.
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