// Animated underwater caustics background for iBreath.
//
// Technique: one seamlessly-tiling offscreen texture drawn as two overlapping
// layers scrolling at slightly different speeds. Their moire pattern creates
// an organic shimmer without any per-frame computation.

export class Caustics {
  #tex = null;

  constructor() {
    this.#buildTex();
  }

  // t — elapsed seconds (any monotonically increasing value is fine)
  draw(ctx, w, h, t) {
    // Base gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0,    '#04101c');
    grad.addColorStop(0.45, '#071f33');
    grad.addColorStop(1,    '#0a2d45');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    if (!this.#tex) return;

    const tex    = this.#tex;
    const scaleH = h / tex.height;
    const tw     = tex.width * scaleH;

    // Two layers scrolling at different speeds — moire creates shimmer
    const off1 = (t * 0.018 * tw) % tw;
    ctx.drawImage(tex, -off1,      0, tw, h);
    ctx.drawImage(tex, -off1 + tw, 0, tw, h);

    const off2 = (t * 0.031 * tw) % tw;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(tex, -off2,      0, tw, h);
    ctx.drawImage(tex, -off2 + tw, 0, tw, h);
    ctx.globalAlpha = 1;
  }

  #buildTex() {
    const TW = 2048, TH = 512;
    const c   = document.createElement('canvas');
    c.width   = TW;
    c.height  = TH;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);

    const rng = lcg(137);

    // Large soft blobs — broad diffuse light pools
    for (let i = 0; i < 55; i++) {
      const bx    = rng() * TW;
      const by    = rng() * TH;
      const rx    = 45 + rng() * 150;
      const ry    = 18 + rng() * 65;
      const alpha = 0.10 + rng() * 0.34;
      blob(ctx, TW, bx, by, rx, ry, rng() * Math.PI, alpha, 80, 200, 238);
    }

    // Small bright spots — tight caustic focal points
    for (let i = 0; i < 45; i++) {
      const bx    = rng() * TW;
      const by    = rng() * TH;
      const rx    = 6 + rng() * 24;
      const ry    = 5 + rng() * 16;
      const alpha = 0.25 + rng() * 0.40;
      blob(ctx, TW, bx, by, rx, ry, rng() * Math.PI, alpha, 160, 235, 255);
    }

    this.#tex = c;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function blob(ctx, tw, bx, by, rx, ry, angle, alpha, r, g, b) {
  for (const mx of [bx, bx - tw]) {
    const gr = ctx.createRadialGradient(mx, by, 0, mx, by, Math.max(rx, ry));
    gr.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr;
    ctx.save();
    ctx.translate(mx, by);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
