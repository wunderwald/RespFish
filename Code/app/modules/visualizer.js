/**
 * Visualizer
 * ==========
 * Renders the demo stream visualization: scrolling waveform trace + fish
 * that follows the breath signal.  Owns the stats bar and scene DOM.
 *
 * Interface expected by renderer.js (all frontends must match):
 *   pushSample(value: number) → void
 *   setStatus({ type: string, text: string }) → void
 *
 * Usage:
 *   const viz = new Visualizer({ statsContainer, sceneContainer });
 *   viz.pushSample(value);
 *   viz.setStatus({ type: 'connected', text: 'MyStream' });
 */

const HISTORY_LEN = 300;
const PADDING = 0.08;
const SHRINK_RATE = 0.0002;  // how fast the auto-range shrinks per frame

export class Visualizer {
  // ring buffer
  #history = new Float32Array(HISTORY_LEN);
  #histIdx = 0;

  // adaptive y-range
  #adaptMin = 0.5;
  #adaptMax = -0.5;

  // stats
  #sampleCount = 0;

  // DOM refs
  #canvas = null;
  #ctx = null;
  #fish = null;
  #statusDot = null;
  #statusText = null;
  #valEl = null;
  #spsEl = null;

  constructor({ statsContainer, sceneContainer }) {
    this.#buildStats(statsContainer);
    this.#buildScene(sceneContainer);
    this.#startSpsCounter();
    requestAnimationFrame(() => this.#draw());
  }

  // public frontend interface

  pushSample(value) {
    this.#history[this.#histIdx] = value;
    this.#histIdx = (this.#histIdx + 1) % HISTORY_LEN;
    this.#sampleCount++;
    this.#valEl.textContent = value.toFixed(3);
  }

  setStatus({ type, text }) {
    this.#statusDot.className = type;
    this.#statusText.textContent = text;
    if (type === "disconnected") this.#valEl.textContent = "—";
  }

  // DOM construction

  #buildStats(container) {
    container.innerHTML = `
      <span>
        <span id="status-dot"></span>
        <span id="status-text">connecting…</span>
      </span>
      <span><span class="label">value</span><span id="val">—</span></span>
      <span><span class="label">samples/s</span><span id="sps">—</span></span>
    `;
    this.#statusDot = container.querySelector("#status-dot");
    this.#statusText = container.querySelector("#status-text");
    this.#valEl = container.querySelector("#val");
    this.#spsEl = container.querySelector("#sps");
  }

  #buildScene(container) {
    container.innerHTML = `
      <canvas id="wave"></canvas>
      <img id="fish" src="fishy.png" alt="fish" />
    `;
    this.#canvas = container.querySelector("#wave");
    this.#ctx = this.#canvas.getContext("2d");
    this.#fish = container.querySelector("#fish");
  }

  // internals

  #startSpsCounter() {
    let lastTick = performance.now();
    setInterval(() => {
      const elapsed = performance.now() - lastTick;
      lastTick = performance.now();
      this.#spsEl.textContent = (this.#sampleCount / elapsed * 1000).toFixed(0);
      this.#sampleCount = 0;
    }, 1000);
  }

  #draw() {
    const canvas = this.#canvas;
    const ctx = this.#ctx;
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    ctx.clearRect(0, 0, w, h);

    // adaptive range
    let bufMin = Infinity, bufMax = -Infinity;
    for (let i = 0; i < HISTORY_LEN; i++) {
      if (this.#history[i] < bufMin) bufMin = this.#history[i];
      if (this.#history[i] > bufMax) bufMax = this.#history[i];
    }
    if (bufMin < this.#adaptMin) this.#adaptMin = bufMin;
    else this.#adaptMin += (bufMin - this.#adaptMin) * SHRINK_RATE;
    if (bufMax > this.#adaptMax) this.#adaptMax = bufMax;
    else this.#adaptMax -= (this.#adaptMax - bufMax) * SHRINK_RATE;

    const min = this.#adaptMin;
    const range = (this.#adaptMax - this.#adaptMin) || 1;
    const pad = PADDING * h;
    const usable = h - pad * 2;

    // waveform trace
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const traceEnd = w * (2 / 3);
    for (let i = 0; i < HISTORY_LEN; i++) {
      const idx = (this.#histIdx + i) % HISTORY_LEN;
      const x = (i / (HISTORY_LEN - 1)) * traceEnd;
      const norm = (this.#history[idx] - min) / range;
      const y = h - pad - norm * usable;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // fish position
    const latestNorm =
      (this.#history[(this.#histIdx + HISTORY_LEN - 1) % HISTORY_LEN] - min) / range;
    const targetY = h - pad - latestNorm * usable;
    this.#fish.style.setProperty("--fish-y", targetY.toFixed(2) + "px");

    requestAnimationFrame(() => this.#draw());
  }
}
export default Visualizer;