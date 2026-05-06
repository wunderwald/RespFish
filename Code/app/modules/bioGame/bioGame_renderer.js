// Pure drawing layer for the bioGame.
// Receives pre-computed render data — no game logic here.

import { STATE, CONFIG } from './bioGame_config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function easeOut(t) { return 1 - (1 - t) * (1 - t); }

// ── BioGameRenderer ───────────────────────────────────────────────────────────

export class BioGameRenderer {
  #canvas = null;
  #ctx    = null;

  // Fish image
  #fishImg       = null;
  #fishImgLoaded = false;
  #fishAspect    = 1;

  // Seamless background texture (pre-rendered offscreen canvas)
  #bgTex = null;

  // Flip-counter digit animation state (4 digits)
  #digits    = [];
  #lastScore = -1;
  #lastNow   = null;

  constructor(container) {
    container.innerHTML = '<canvas id="bg-canvas"></canvas>';
    this.#canvas = container.querySelector('#bg-canvas');
    this.#ctx    = this.#canvas.getContext('2d');

    this.#loadFishImg();
    this.#buildBgTex();
    this.#initDigits();
    this.#warmUpShadow();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  draw(renderData) {
    const canvas = this.#canvas;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = this.#ctx;
    const w   = canvas.width;
    const h   = canvas.height;
    const { state, now } = renderData;

    // dt for internal animations (flip counter)
    const dt = this.#lastNow != null ? clamp((now - this.#lastNow) / 1000, 0, 0.05) : 0;
    this.#lastNow = now;

    ctx.clearRect(0, 0, w, h);
    this.#drawBg(ctx, w, h, renderData.bgScrollX ?? 0);

    switch (state) {
      case STATE.IDLE:
        this.#drawCenter(ctx, w, h, 'waiting for stream…', 'rgba(255,255,255,0.38)', 20);
        break;

      case STATE.CALIBRATING:
        this.#drawCalibrating(ctx, w, h, renderData.calProgress ?? 0, renderData.calRemaining ?? 0);
        break;

      case STATE.READY:
        this.#drawReady(ctx, w, h, renderData.blockIndex ?? 0, now);
        break;

      case STATE.COUNTDOWN:
        this.#drawCountdown(ctx, w, h, renderData.countdownValue ?? 3, renderData.countdownProgress ?? 0);
        break;

      case STATE.PLAYING:
        this.#drawPlaying(ctx, w, h, renderData, dt);
        break;

      case STATE.INTERMISSION:
        this.#drawIntermission(ctx, w, h, renderData.scoreBlock1 ?? 0);
        break;

      case STATE.DONE:
        this.#drawDone(ctx, w, h, renderData.scoreBlock1 ?? 0, renderData.scoreBlock2 ?? 0);
        break;
    }
  }

  // ── Background ────────────────────────────────────────────────────────────

  #drawBg(ctx, w, h, scrollX) {
    if (!this.#bgTex) {
      ctx.fillStyle = '#0a2a4a';
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const tex = this.#bgTex;
    const scaleH = h / tex.height;
    const tw = tex.width * scaleH;          // scaled texture width
    const ox = -(scrollX * w) % tw;         // scrollX in canvas-widths
    ctx.drawImage(tex, ox,      0, tw, h);
    ctx.drawImage(tex, ox + tw, 0, tw, h);  // seamless second copy
  }

  #buildBgTex() {
    const tw = CONFIG.BG_TEX_WIDTH;
    const th = CONFIG.BG_TEX_HEIGHT;
    const c  = document.createElement('canvas');
    c.width  = tw;
    c.height = th;
    const ctx = c.getContext('2d');

    // Base gradient — dark blue-teal
    const grad = ctx.createLinearGradient(0, 0, 0, th);
    grad.addColorStop(0,    '#071830');
    grad.addColorStop(0.45, '#0a2a48');
    grad.addColorStop(1,    '#0d3858');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, tw, th);

    // Caustic-light blobs — deterministic pseudo-random for seamless tiling
    const rng = (() => {
      let s = 42;
      return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    })();

    for (let i = 0; i < 70; i++) {
      const bx    = rng() * tw;
      const by    = rng() * th;
      const rx    = 25 + rng() * 130;
      const ry    = 15 + rng() * 70;
      const alpha = 0.025 + rng() * 0.055;

      // Draw blob and its seamless mirror at bx - tw
      for (const mx of [bx, bx - tw]) {
        const g = ctx.createRadialGradient(mx, by, 0, mx, by, Math.max(rx, ry));
        g.addColorStop(0, `rgba(100,210,255,${alpha})`);
        g.addColorStop(1, 'rgba(100,210,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(mx, by, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.#bgTex = c;
  }

  // ── Shadow warm-up ────────────────────────────────────────────────────────

  #warmUpShadow() {
    // The first ctx.fill() with a given shadowBlur value triggers GPU shader
    // compilation in Chromium, causing a one-frame stutter. Drawing off-screen
    // here pre-compiles both radii used during gameplay (6 for particles, 8 for stars).
    const ctx = this.#ctx;
    ctx.save();
    ctx.fillStyle = '#fff';
    for (const blur of [6, 8]) {
      ctx.shadowBlur  = blur;
      ctx.shadowColor = '#fff';
      ctx.beginPath();
      ctx.arc(-1000, -1000, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Fish image ────────────────────────────────────────────────────────────

  #loadFishImg() {
    const img = new Image();
    img.onload = () => {
      this.#fishImg       = img;
      this.#fishImgLoaded = true;
      this.#fishAspect    = img.naturalWidth / img.naturalHeight;
    };
    img.src = 'fishy.png';
  }

  #drawFish(ctx, screenX, screenY, heightPx, tilt = 0) {
    const w = heightPx * this.#fishAspect;
    const h = heightPx;
    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(tilt);
    if (this.#fishImgLoaded) {
      ctx.drawImage(this.#fishImg, -w / 2, -h / 2, w, h);
    } else {
      // Fallback oval until image loads
      ctx.fillStyle = 'rgba(255,220,120,0.85)';
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Starfish ──────────────────────────────────────────────────────────────

  #drawStarfishes(ctx, w, h, topPad, playH, starfishes) {
    for (const star of starfishes) {
      if (star.xRatio < -0.15 || star.xRatio > 1.15) continue;
      const sx   = star.xRatio * w;
      const sy   = topPad + (1 - star.normY) * playH;
      const size = CONFIG.STARFISH_SIZE_RATIO * h;

      if (star.collectT != null) {
        const t     = clamp(star.collectT / 0.45, 0, 1);
        const alpha = 1 - t;
        const scale = 1 + 0.6 * easeOut(t);
        this.#drawStar(ctx, sx, sy, size * scale, alpha, '#ffd060');
      } else if (star.missT != null) {
        const alpha = clamp(1 - star.missT / 0.5, 0, 1);
        this.#drawStar(ctx, sx, sy, size, alpha, '#888');
      } else {
        this.#drawStar(ctx, sx, sy, size, 1, '#ffbe30');
      }
    }
  }

  // 5-pointed star centred at (cx, cy) with outer radius r
  #drawStar(ctx, cx, cy, r, alpha, color = '#ffbe30') {
    const ri   = r * 0.42;   // inner radius
    const pts  = 5;
    const base = -Math.PI / 2;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 8;

    ctx.beginPath();
    for (let i = 0; i < pts * 2; i++) {
      const rad = i % 2 === 0 ? r : ri;
      const ang = base + (i * Math.PI) / pts;
      i === 0
        ? ctx.moveTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad)
        : ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ── Target curve ──────────────────────────────────────────────────────────

  #drawCurve(ctx, w, h, topPad, playH, blockTime, bpm) {
    const period = 60 / bpm;
    ctx.save();
    ctx.beginPath();
    for (let px = 0; px <= w; px += 4) {
      const tOff = (px / w - CONFIG.FISH_X_RATIO) / CONFIG.STARFISH_SCROLL_SPEED;
      const normY = 0.5 + 0.45 * Math.sin(2 * Math.PI * (blockTime + tOff) / period);
      const sy    = topPad + (1 - normY) * playH;
      px === 0 ? ctx.moveTo(px, sy) : ctx.lineTo(px, sy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([12, 10]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Timer bar ─────────────────────────────────────────────────────────────

  #drawTimerBar(ctx, w, h, blockElapsed, now) {
    const total    = CONFIG.BLOCK_DURATION_SECS;
    const timeLeft = Math.max(0, total - blockElapsed);
    const ratio    = clamp(timeLeft / total, 0, 1);

    const barMaxW  = Math.min(240, w * 0.25);
    const barH     = 9;
    const padRight = 20;
    const padTop   = 18;
    const barRight = w - padRight;
    const barY     = padTop;

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(barRight - barMaxW, barY, barMaxW, barH, 4);
    ctx.fill();

    // Filled portion — right-anchored, shrinks left
    const filledW = barMaxW * ratio;
    if (filledW > 2) {
      let barColor;
      if (timeLeft > 60) {
        barColor = 'rgba(255,255,255,0.88)';
      } else if (timeLeft > 15) {
        const t = (60 - timeLeft) / 45;
        barColor = `rgba(255,${Math.round(lerp(255, 160, t))},${Math.round(lerp(255, 30, t))},0.92)`;
      } else {
        const flash = 0.55 + 0.45 * Math.sin(now * 0.008);
        barColor = `rgba(255,70,70,${flash})`;
      }
      ctx.fillStyle = barColor;
      ctx.beginPath();
      ctx.roundRect(barRight - filledW, barY, filledW, barH, 4);
      ctx.fill();
    }

    // Remaining seconds label
    const secs = Math.ceil(timeLeft);
    const mm   = String(Math.floor(secs / 60)).padStart(1, '0');
    const ss   = String(secs % 60).padStart(2, '0');
    ctx.fillStyle    = 'rgba(255,255,255,0.45)';
    ctx.font         = '300 12px Nunito, sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${mm}:${ss}`, barRight, barY + barH + 5);
  }

  // ── Score / flip counter ──────────────────────────────────────────────────

  #initDigits() {
    for (let i = 0; i < 4; i++) {
      this.#digits.push({ shown: 0, from: 0, to: 0, animT: 1 });
    }
  }

  #updateDigits(score, dt) {
    // Advance existing animations
    for (const d of this.#digits) {
      if (d.animT < 1) d.animT = Math.min(1, d.animT + dt / 0.32);
    }
    if (score === this.#lastScore) return;
    this.#lastScore = score;

    const str = String(score).padStart(4, '0');
    for (let i = 0; i < 4; i++) {
      const n = parseInt(str[i]);
      const d = this.#digits[i];
      if (n !== d.shown) {
        d.from  = d.shown;
        d.to    = n;
        d.shown = n;
        d.animT = 0;
      }
    }
  }

  #drawScoreDisplay(ctx, x, y, score, dt) {
    this.#updateDigits(score, dt);

    const cardW = 30;
    const cardH = 44;
    const gap   = 5;

    for (let i = 0; i < 4; i++) {
      const cx = x + i * (cardW + gap);
      const cy = y;
      const d  = this.#digits[i];

      // Card background
      ctx.fillStyle = 'rgba(0,0,0,0.48)';
      ctx.beginPath();
      ctx.roundRect(cx, cy, cardW, cardH, 6);
      ctx.fill();

      // Clip to card for slide animation
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(cx, cy, cardW, cardH, 6);
      ctx.clip();

      const t = easeOut(clamp(d.animT, 0, 1));
      if (d.animT < 1) {
        // Old digit slides upward
        const oldY = cy - t * cardH;
        this.#drawDigitChar(ctx, String(d.from), cx, oldY, cardW, cardH, 1 - t);
        // New digit slides in from below
        const newY = cy + (1 - t) * cardH;
        this.#drawDigitChar(ctx, String(d.to), cx, newY, cardW, cardH, t);
      } else {
        this.#drawDigitChar(ctx, String(d.shown), cx, cy, cardW, cardH, 1);
      }

      // Centre divider line (mechanical flip look)
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(cx,        cy + cardH / 2);
      ctx.lineTo(cx + cardW, cy + cardH / 2);
      ctx.stroke();

      ctx.restore();
    }

    // "score" label below
    ctx.fillStyle    = 'rgba(255,255,255,0.35)';
    ctx.font         = '300 11px Nunito, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('score', x, y + cardH + 5);
  }

  #drawDigitChar(ctx, char, x, y, w, h, alpha) {
    ctx.fillStyle    = `rgba(255,255,255,${alpha * 0.92})`;
    ctx.font         = `400 ${Math.round(h * 0.62)}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(char, x + w / 2, y + h / 2);
  }

  // ── State draw methods ────────────────────────────────────────────────────

  #drawCalibrating(ctx, w, h, progress, remaining) {
    const cx = w / 2, cy = h / 2;
    const r  = 62;

    this.#drawCenter(ctx, w, h * 0.35, 'Breathe normally…', 'rgba(255,255,255,0.82)', 22);

    // Track ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 5;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = 'rgba(174,212,237,0.8)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.lineCap     = 'butt';

    this.#drawCenter(ctx, w, cy, String(remaining), 'rgba(255,255,255,0.72)', 54, '200');
    this.#drawCenter(ctx, w, cy + r + 28, 'calibrating signal…', 'rgba(255,255,255,0.28)', 14);
  }

  #drawReady(ctx, w, h, blockIndex, now) {
    const bobNormY = 0.5 + 0.25 * Math.sin(now / 1000 * 1.5);
    const tilt     = -0.2 * Math.cos(now / 1000 * 1.5);
    const topPad   = h * 0.10;
    const playH    = h * 0.80;
    const fishScreenX = w / 2;
    const fishScreenY = topPad + (1 - bobNormY) * playH;
    const fishH = CONFIG.FISH_SIZE_MIN * h + (CONFIG.FISH_SIZE_MAX - CONFIG.FISH_SIZE_MIN) * h * 0.5;
    this.#drawFish(ctx, fishScreenX, fishScreenY, fishH * 1.3, tilt);
    this.#drawCenter(ctx, w, h * 0.80, 'Press Space or Start to begin', 'rgba(255,255,255,0.30)', 16);
  }

  #drawCountdown(ctx, w, h, value, progress) {
    const text  = value === 0 ? 'GO!' : String(value);
    const color = value === 0 ? 'rgba(126,232,162,0.95)' : 'rgba(255,255,255,0.92)';
    const size  = value === 0 ? 84 : 108;
    const scale = 1 + 0.35 * (1 - easeOut(clamp(progress, 0, 1)));

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle    = color;
    ctx.font         = `200 ${size}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  #drawPlaying(ctx, w, h, data, dt) {
    const {
      fishNormY, fishNormSize, fishTilt = 0, fishBumpT,
      starfishes, particles, score, blockTime, bpm, showCurve, group, now,
    } = data;

    // Playfield geometry (10% padding top & bottom)
    const topPad = h * 0.10;
    const playH  = h * 0.80;
    const normToScreenY = (ny) => topPad + (1 - ny) * playH;

    // Target curve (optional)
    if (showCurve) {
      this.#drawCurve(ctx, w, h, topPad, playH, blockTime, bpm);
    }

    // Starfishes
    this.#drawStarfishes(ctx, w, h, topPad, playH, starfishes);

    // Particles
    if (particles?.length) {
      this.#drawParticles(ctx, w, h, topPad, playH, particles);
    }

    // Fish (with collect-bump scale)
    const fishScreenX = CONFIG.FISH_X_RATIO * w;
    const fishScreenY = normToScreenY(fishNormY);
    const baseH = (CONFIG.FISH_SIZE_MIN + fishNormSize * (CONFIG.FISH_SIZE_MAX - CONFIG.FISH_SIZE_MIN)) * h;
    const bumpScale = fishBumpT != null
      ? 1 + 0.28 * Math.sin(Math.PI * fishBumpT / 0.3)
      : 1;
    this.#drawFish(ctx, fishScreenX, fishScreenY, baseH * bumpScale, fishTilt);

    // Score + timer — only for slow condition
    if (group === 'slow') {
      this.#drawScoreDisplay(ctx, 18, 16, score, dt);
      this.#drawTimerBar(ctx, w, h, blockTime, now);
    }
  }

  #drawParticles(ctx, w, h, topPad, playH, particles) {
    ctx.save();
    ctx.shadowBlur = 6;  // constant for all particles — set once outside loop
    for (const p of particles) {
      const sx = p.x * w;
      const sy = topPad + (1 - p.y) * playH;
      const r  = p.r * h;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle   = p.color;
      ctx.shadowColor = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  #drawIntermission(ctx, w, h, score) {
    // Backdrop overlay
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const cy = h / 2;

    this.#drawCenter(ctx, w, cy - 80, 'Game 1 complete  ·  Good job!', 'rgba(255,255,255,0.85)', 30, '300');

    // Big score
    const scoreStr = `★  ${score}  ★`;
    ctx.fillStyle    = '#ffd060';
    ctx.font         = '300 60px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,200,50,0.6)';
    ctx.shadowBlur   = 20;
    ctx.fillText(scoreStr, w / 2, cy);
    ctx.shadowBlur   = 0;

    const label = score === 1 ? '1 starfish caught' : `${score} starfish caught`;
    this.#drawCenter(ctx, w, cy + 60, label, 'rgba(255,255,255,0.55)', 18);
    this.#drawCenter(ctx, w, cy + 110, 'Press Space', 'rgba(255,255,255,0.28)', 15);
  }

  #drawDone(ctx, w, h, score1, score2) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const cy    = h / 2;
    const total = score1 + score2;

    this.#drawCenter(ctx, w, cy - 90, 'Experiment complete!', 'rgba(255,255,255,0.85)', 28, '300');

    ctx.fillStyle    = '#ffd060';
    ctx.font         = '200 72px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,200,50,0.55)';
    ctx.shadowBlur   = 22;
    ctx.fillText(`★  ${total}  ★`, w / 2, cy);
    ctx.shadowBlur   = 0;

    this.#drawCenter(ctx, w, cy + 65,  `Game 1: ${score1}  ·  Game 2: ${score2}`, 'rgba(255,255,255,0.42)', 16);
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────

  #drawCenter(ctx, w, y, text, color, size, weight = '300') {
    ctx.fillStyle    = color;
    ctx.font         = `${weight} ${size}px Nunito, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, y);
  }
}
