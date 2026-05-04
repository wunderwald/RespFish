/**
 * renderer.js — orchestrator
 * ==========================
 * Wires the stream infrastructure to the active frontend.
 *
 * ── Switching frontends ───────────────────────────────────────────────────
 * Change the FRONTEND constant below to swap the active frontend.
 * Valid values: 'visualizer' | 'game' | 'ibreath'
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

import { StreamManager } from "./modules/stream.js";
import { GazeManager   } from "./modules/gazeCalibration.js";

// ── Active frontend ───────────────────────────────────────────────────────────
//
// Change this value to switch frontends.
// 'visualizer' | 'game' | 'ibreath' | 'gazetest'

const FRONTEND = 'game';

// ── Gaze tracking ─────────────────────────────────────────────────────────────
//
// Set GAZE_ENABLED = true to show the 9-point calibration screen on startup
// and stream gaze data into window.gazeState for the iBreath CSV logger.
// Set to false to skip entirely (no webcam needed — useful for game/visualizer
// or when testing ibreath without eye tracking).

const GAZE_ENABLED = false;

// ── Mount points (defined in index.html) ─────────────────────────────────────

const streamContainer = document.getElementById("stream-bar");
const statsContainer  = document.getElementById("stats");
const sceneContainer  = document.getElementById("scene");

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
  const { default: FrontendClass } = await import(`./modules/${FRONTEND}.js`);

  // 4. Instantiate — every frontend receives the same two containers.
  const frontend = new FrontendClass({ statsContainer, sceneContainer });

  // 5. Instantiate the stream manager and wire its events to the frontend.
  const stream = new StreamManager({ container: streamContainer });
  stream.on("sample", ({ value }) => frontend.pushSample(value));
  stream.on("status", (event)     => frontend.setStatus(event));
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