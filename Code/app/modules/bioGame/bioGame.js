/**
 * bioGame.js — Biofeedback game (placeholder)
 * =============================================
 * Implements the standard frontend interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 *
 * Game logic will be filled in once requirements are defined.
 */

// ── Game states ───────────────────────────────────────────────────────────────

const STATE = {
  IDLE:      'idle',
  PLAYING:   'playing',
  GAME_OVER: 'game_over',
};

// ── BioGame ───────────────────────────────────────────────────────────────────

export default class BioGame {
  #canvas  = null;
  #ctx     = null;
  #state   = STATE.IDLE;
  #rafId   = null;

  // Stream state
  #streamConnected = false;
  #lastValue       = 0;

  constructor({ sceneContainer }) {
    this.#buildScene(sceneContainer);
    this.#loop();

    window.api.frontend.onAction(({ type }) => {
      if (type === 'start') this.#startGame();
    });

    this.#pushState();
  }

  // ── Public interface (renderer.js) ────────────────────────────────────────

  pushSample(value) {
    this.#lastValue = value;
  }

  setStatus({ type }) {
    this.#streamConnected = (type === 'connected');
    this.#pushState();
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  #buildScene(container) {
    container.innerHTML = '<canvas id="bg-canvas"></canvas>';
    this.#canvas = container.querySelector('#bg-canvas');
    this.#ctx    = this.#canvas.getContext('2d');
  }

  // ── Game control ──────────────────────────────────────────────────────────

  #startGame() {
    if (!this.#streamConnected) return;
    this.#state = STATE.PLAYING;
    this.#pushState();
  }

  #endGame() {
    this.#state = STATE.GAME_OVER;
    this.#pushState();
  }

  // ── Experimenter state push ───────────────────────────────────────────────

  #pushState() {
    const connected = this.#streamConnected;
    window.api.frontend.sendState({
      stateText:  this.#state === STATE.IDLE
        ? (connected ? 'ready' : 'waiting for stream…')
        : this.#state === STATE.PLAYING ? 'playing' : 'game over',
      btnEnabled: connected && this.#state !== STATE.PLAYING,
      btnText:    this.#state === STATE.GAME_OVER ? 'Play again' : 'Start',
    });
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  #loop() {
    this.#rafId = requestAnimationFrame(() => this.#loop());
    this.#draw();
  }

  #draw() {
    const canvas = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = this.#ctx;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!this.#streamConnected) {
      this.#centerText(ctx, w / 2, h / 2, 'waiting for stream…', 'rgba(255,255,255,0.35)', 18);
      return;
    }

    if (this.#state === STATE.IDLE) {
      this.#centerText(ctx, w / 2, h / 2, 'Press Start', 'rgba(255,255,255,0.35)', 18);
      return;
    }

    if (this.#state === STATE.GAME_OVER) {
      this.#centerText(ctx, w / 2, h / 2, 'Game Over', 'rgba(255,255,255,0.6)', 24);
      return;
    }

    // STATE.PLAYING — placeholder: draw a bar that reflects the breath signal
    const barH = Math.max(4, this.#lastValue * h * 0.8);
    const barW = 40;
    const bx = (w - barW) / 2;
    const by = h - barH;
    ctx.fillStyle = 'rgba(174, 212, 237, 0.7)';
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, 6);
    ctx.fill();
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────

  #centerText(ctx, x, y, text, color, size, weight = '300') {
    ctx.fillStyle  = color;
    ctx.font       = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }
}
