/**
 * baseline.js — Resting-state baseline recording
 * ================================================
 * Shows a neutral display for a fixed duration (default 5 min).
 * Records the resp signal and writes it to CSV on completion.
 * Sends LSL markers at start and end.
 *
 * State machine:  IDLE → PLAYING → DONE
 */

import { MarkerStream } from '../stream/markerStream.js';
import { CONFIG, STATE } from './baseline_config.js';

export default class Baseline {
  #state        = STATE.IDLE;
  #streamReady  = false;
  #startTime    = null;
  #lastRafTime  = null;

  // Experimenter-supplied params (overridden on 'start' action)
  #subjectCode = CONFIG.SUBJECT_CODE;
  #dataDir     = CONFIG.DATA_DIR;

  // Recorded samples: [isoTimestamp, value]
  #sampleBuffer = [];

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

  // ── Frontend interface ─────────────────────────────────────────────────────

  pushSample(value) {
    if (this.#state !== STATE.PLAYING) return;
    this.#sampleBuffer.push([new Date().toISOString(), value]);
  }

  setStatus({ type, text }) {
    if (this.#state !== STATE.IDLE) return;
    this.#streamReady = type === 'connected';
    this.#pushState({
      stateText:    this.#streamReady ? 'stream ready' : (text ?? 'no stream'),
      startEnabled: this.#streamReady,
    });
  }

  // ── Action handler ────────────────────────────────────────────────────────

  #onAction({ type, subjectCode, dataDir }) {
    switch (type) {
      case 'start':
        if (subjectCode !== undefined) this.#subjectCode = subjectCode;
        if (dataDir     !== undefined) this.#dataDir     = dataDir;
        if (this.#state === STATE.IDLE && this.#streamReady) this.#begin();
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
    this.#startTime    = performance.now();
    this.#sampleBuffer = [];
    this.#state        = STATE.PLAYING;
    this.#markers.send('baseline_start');
    this.#pushState({
      stateText:    'recording',
      startEnabled: false,
      abortVisible: true,
      inputsLocked: true,
    });
  }

  #finish(aborted = false) {
    this.#state = STATE.DONE;
    this.#markers.send(aborted ? 'baseline_abort' : 'baseline_end');
    this.#pushState({ stateText: aborted ? 'aborted' : 'done', abortVisible: false });
    this.#writeCSV();
  }

  // ── Tick (duration check) ─────────────────────────────────────────────────

  #tick() {
    if (this.#state !== STATE.PLAYING) return;
    const elapsed = (performance.now() - this.#startTime) / 1000;
    if (elapsed >= CONFIG.DURATION_SECS) this.#finish(false);
  }

  // ── CSV output ────────────────────────────────────────────────────────────

  async #writeCSV() {
    if (!window.api || this.#sampleBuffer.length === 0) return;
    const dir    = this.#dataDir;
    const result = await window.api.ensureDir(dir);
    if (!result.ok) {
      console.error('[Baseline] could not create data dir:', result.error);
      return;
    }
    const path    = `${dir}/${this.#subjectCode}_baseline.csv`;
    const header  = 'timestamp,value\n';
    const rows    = this.#sampleBuffer
      .map(([t, v]) => `${t},${v.toFixed(6)}`)
      .join('\n') + '\n';
    const write = await window.api.writeCSV(path, header + rows);
    if (write.ok) {
      console.log(`[Baseline] saved ${this.#sampleBuffer.length} samples → ${path}`);
    } else {
      console.error('[Baseline] CSV write failed:', write.error);
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  #rafLoop(now) {
    this.#lastRafTime = now;
    try { this.#draw(now); } catch (e) { console.error('[Baseline] draw error:', e); }
    requestAnimationFrame((t) => this.#rafLoop(t));
  }

  #draw(now) {
    const canvas  = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = this.#ctx;
    const w = canvas.width, h = canvas.height;

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
      const mm = String(Math.floor(remaining / 60)).padStart(1, '0');
      const ss = String(Math.floor(remaining % 60)).padStart(2, '0');
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
      startEnabled: this.#state === STATE.IDLE && this.#streamReady,
      abortVisible: false,
      ...overrides,
    });
  }
}
