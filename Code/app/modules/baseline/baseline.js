/**
 * baseline.js — Resting-state baseline recording
 * ================================================
 * Shows a neutral display for a fixed duration (default 5 min).
 * Sends a marker at start and end. No breath signal required.
 *
 * State machine:  IDLE → PLAYING → DONE
 *
 * Implements the standard frontend interface:
 *   pushSample(value) → void   (no-op — no breath signal needed)
 *   setStatus({ type, text })  (no-op — no stream required)
 */

import { MarkerStream } from '../stream/markerStream.js';
import { CONFIG, STATE } from './baseline_config.js';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export default class Baseline {
  #state       = STATE.IDLE;
  #startTime   = null;   // performance.now() when recording began
  #lastRafTime = null;

  #canvas  = null;
  #ctx     = null;
  #markers = null;

  constructor({ sceneContainer }) {
    sceneContainer.innerHTML = '<canvas id="bl-canvas"></canvas>';
    this.#canvas = sceneContainer.querySelector('#bl-canvas');
    this.#ctx    = this.#canvas.getContext('2d');

    this.#markers = CONFIG.SEND_MARKERS
      ? new MarkerStream(CONFIG.MARKER_STREAM_URL)
      : { send() {} };

    window.api.frontend.onAction((action) => this.#onAction(action));

    setInterval(() => this.#tick(), 100);
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  // Baseline needs no breath signal — satisfy the standard interface
  pushSample() {}
  setStatus()  {}

  // ── Action handler ────────────────────────────────────────────────────────

  #onAction({ type }) {
    switch (type) {
      case 'start':
        if (this.#state === STATE.IDLE) this.#begin();
        break;
      case 'abort':
        if (this.#state === STATE.PLAYING) this.#finish(true);
        break;
      case 'ready':
        this.#pushState();
        break;
    }
  }

  // ── State transitions ─────────────────────────────────────────────────────

  #begin() {
    this.#startTime = performance.now();
    this.#state     = STATE.PLAYING;
    this.#markers.send('baseline_start');
    this.#pushState({ stateText: 'recording', startEnabled: false, abortVisible: true });
  }

  #finish(aborted = false) {
    this.#state = STATE.DONE;
    this.#markers.send(aborted ? 'baseline_abort' : 'baseline_end');
    this.#pushState({ stateText: aborted ? 'aborted' : 'done', abortVisible: false });
  }

  // ── Tick (duration check) ─────────────────────────────────────────────────

  #tick() {
    if (this.#state !== STATE.PLAYING) return;
    const elapsed = (performance.now() - this.#startTime) / 1000;
    if (elapsed >= CONFIG.DURATION_SECS) this.#finish(false);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  #rafLoop(now) {
    this.#lastRafTime = now;
    try {
      this.#draw(now);
    } catch (e) {
      console.error('[Baseline] draw error:', e);
    }
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  #draw(now) {
    const canvas  = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = this.#ctx;
    const w = canvas.width, h = canvas.height;

    // Background
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    if (this.#state === STATE.IDLE) {
      ctx.font      = '200 28px Nunito, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillText('Standby', w / 2, h / 2);

    } else if (this.#state === STATE.PLAYING) {
      const remaining = Math.max(0, CONFIG.DURATION_SECS - (now - this.#startTime) / 1000);
      const mm  = String(Math.floor(remaining / 60)).padStart(1, '0');
      const ss  = String(Math.floor(remaining % 60)).padStart(2, '0');
      ctx.font      = '200 80px Nunito, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`${mm}:${ss}`, w / 2, h / 2);

    } else if (this.#state === STATE.DONE) {
      ctx.font      = '200 28px Nunito, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText('Done', w / 2, h / 2);
    }
  }

  // ── Experimenter state push ───────────────────────────────────────────────

  #pushState(overrides = {}) {
    window.api.frontend.sendState({
      stateText:    this.#state,
      startEnabled: this.#state === STATE.IDLE,
      abortVisible: false,
      ...overrides,
    });
  }
}
