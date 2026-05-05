/**
 * renderer.js — orchestrator
 * ==========================
 * Wires the stream infrastructure to the active frontend.
 *
 * ── Switching frontends ───────────────────────────────────────────────────
 * Change the FRONTEND constant below to swap the active frontend.
 * Valid values: 'visualizer' | 'trainingGame' | 'ibreath' | 'gazetest'
 *
 * Every frontend module must implement this interface:
 *   pushSample(value: number) → void
 *   setStatus({ type: string, text: string }) → void
 *
 * Every frontend is expected to have a matching stylesheet at:
 *   styles/<name>.css
 * which is injected dynamically so only the active frontend's CSS is loaded.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { GazeManager } from "./modules/webgazer/gazeCalibration.js";

// ── Active frontend ───────────────────────────────────────────────────────────
//
// Set via the npm script: npm run ibreath | trainingGame | visualizer | gazetest | bioGame
// Falls back to 'ibreath' if no ?frontend= param is present.

const FRONTEND = new URLSearchParams(location.search).get('frontend') || 'ibreath';

// ── Gaze tracking ─────────────────────────────────────────────────────────────
//
// Set GAZE_ENABLED = true to show the 9-point calibration screen on startup
// and stream gaze data into window.gazeState for the iBreath CSV logger.
// Set to false to skip entirely (no webcam needed — useful for trainingGame/visualizer
// or when testing ibreath without eye tracking).

const GAZE_ENABLED = false;

// ── Mount points (defined in index.html) ─────────────────────────────────────

const statsContainer = document.getElementById("stats");
const sceneContainer = document.getElementById("scene");

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  // 1. Inject the frontend's stylesheet before the module loads so that the
  //    DOM is already styled when the constructor runs.
  injectCSS(`styles/${FRONTEND}.css`);

  // 2. Run gaze calibration if enabled.
  //    This blocks until the experimenter accepts or skips calibration,
  //    so the frontend is not yet visible during this phase.
  const gaze = new GazeManager();
  if (GAZE_ENABLED) {
    await gaze.runCalibration();
    // runCalibration() calls start() internally on Accept.
    // This is a safety net for the skip path.
    if (!gaze.isActive) gaze.start();
  }

  // 3. Dynamically import the frontend module.
  const FRONTEND_PATHS = {
    visualizer: './modules/visualizer/visualizer.js',
    trainingGame: './modules/trainingGame/trainingGame.js',
    ibreath:    './modules/ibreath/ibreath.js',
    gazetest:   './modules/webgazer/gazetest.js',
    bioGame:    './modules/bioGame/bioGame.js',
  };
  const { default: FrontendClass } = await import(FRONTEND_PATHS[FRONTEND]);

  // 4. Instantiate — the experimenter window handles all HUD and stats displays;
  //    the scene window hides its stats container for all frontends.
  statsContainer.style.display = 'none';
  let hudFactory;
  if (FRONTEND === 'ibreath') {
    const { RemoteHud } = await import('./modules/remoteHud.js');
    hudFactory = (callbacks) => new RemoteHud(callbacks);
  }
  const frontend = new FrontendClass({ statsContainer, sceneContainer, hudFactory });

  // 5. Receive stream data forwarded from the experimenter window via IPC.
  window.api.stream.onSample(({ value }) => frontend.pushSample(value));
  window.api.stream.onStatus((event)     => frontend.setStatus(event));
  window.api.stream.onGazeSample(({ channels }) => frontend.pushGazeSample?.(channels));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Injects a <link rel="stylesheet"> into <head> for the given href.
 * No-ops if a link for that href already exists.
 */
function injectCSS(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel  = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

// ── Run ───────────────────────────────────────────────────────────────────────

init().catch((err) => {
  console.error("[renderer] failed to load frontend:", err);
  sceneContainer.innerHTML = `
    <div style="color:#e07878;padding:2rem;font-family:monospace">
      <strong>Frontend failed to load: ${FRONTEND}</strong><br>
      <pre>${err.message}</pre>
    </div>
  `;
});