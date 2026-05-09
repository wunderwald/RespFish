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
  #scene  = null;

  // Avatar image
  #avatarImg       = null;
  #avatarImgLoaded = false;
  #avatarAspect    = 1;

  // Seamless background texture (pre-rendered offscreen canvas)
  #bgTex = null;

  // Flip-counter digit animation state (4 digits)
  #digits    = [];
  #lastScore = -1;
  #lastNow   = null;

  constructor(container, scene) {
    this.#scene = scene;

    container.innerHTML = '<canvas id="bg-canvas"></canvas>';
    this.#canvas = container.querySelector('#bg-canvas');
    this.#ctx    = this.#canvas.getContext('2d');

    this.#loadAvatarImg();
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
        this.#drawIntermission(ctx, w, h, renderData.scoreBlock1 ?? 0, renderData.gameOver ?? false);
        break;

      case STATE.DONE:
        this.#drawDone(ctx, w, h, renderData.scoreBlock1 ?? 0, renderData.scoreBlock2 ?? 0, renderData.gameOver ?? false);
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
    const tw = tex.width * scaleH;
    const ox = -(scrollX * w) % tw;
    ctx.drawImage(tex, ox,      0, tw, h);
    ctx.drawImage(tex, ox + tw, 0, tw, h);
  }

  #buildBgTex() {
    const tw  = CONFIG.BG_TEX_WIDTH;
    const th  = CONFIG.BG_TEX_HEIGHT;
    const c   = document.createElement('canvas');
    c.width   = tw;
    c.height  = th;
    const ctx = c.getContext('2d');
    const bg  = this.#scene.bg;

    // Base gradient
    const grad = ctx.createLinearGradient(0, 0, 0, th);
    grad.addColorStop(0,    bg.gradTop);
    grad.addColorStop(0.45, bg.gradMid);
    grad.addColorStop(1,    bg.gradBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, tw, th);

    const rng = (() => {
      let s = 42;
      return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    })();

    if (this.#scene.id === 'jungle') {
      this.#buildJungleTex(ctx, tw, th, bg, rng);
    } else {
      this.#buildOceanTex(ctx, tw, th, bg, rng);
    }

    this.#bgTex = c;
  }

  #buildOceanTex(ctx, tw, th, bg, rng) {
    for (let i = 0; i < 70; i++) {
      const bx    = rng() * tw;
      const by    = rng() * th;
      const rx    = 25 + rng() * 130;
      const ry    = 15 + rng() * 70;
      const alpha = 0.025 + rng() * 0.055;

      for (const mx of [bx, bx - tw]) {
        const g = ctx.createRadialGradient(mx, by, 0, mx, by, Math.max(rx, ry));
        g.addColorStop(0, `rgba(${bg.blobR},${bg.blobG},${bg.blobB},${alpha})`);
        g.addColorStop(1, `rgba(${bg.blobR},${bg.blobG},${bg.blobB},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(mx, by, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  #buildJungleTex(ctx, tw, th, bg, rng) {
    // Ground strip
    const grd = ctx.createLinearGradient(0, th * 0.72, 0, th);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,12,0,0.55)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, tw, th);

    // Subtle light patches (filtered sunlight through canopy)
    for (let i = 0; i < 18; i++) {
      const bx = rng() * tw;
      const by = rng() * th * 0.85;
      const r  = 22 + rng() * 55;
      const alpha = 0.03 + rng() * 0.035;
      for (const mx of [bx, bx - tw]) {
        const g = ctx.createRadialGradient(mx, by, 0, mx, by, r);
        g.addColorStop(0, `rgba(150,230,70,${alpha})`);
        g.addColorStop(1, 'rgba(150,230,70,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(mx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Tree silhouettes
    for (let i = 0; i < 12; i++) {
      const bx      = rng() * tw;
      const groundY = th * (0.72 + rng() * 0.22);
      const trunkW  = 10 + rng() * 14;
      const trunkH  = 70 + rng() * 110;
      const canopyR = 42 + rng() * 55;

      for (const mx of [bx, bx - tw]) {
        // Trunk
        ctx.fillStyle = 'rgba(6,14,5,0.92)';
        ctx.fillRect(mx - trunkW / 2, groundY - trunkH, trunkW, trunkH);

        // Canopy — 3 overlapping circles
        for (let ci = 0; ci < 3; ci++) {
          const cx2 = mx + (rng() - 0.5) * canopyR * 0.7;
          const cy2 = groundY - trunkH + (rng() - 0.6) * canopyR * 0.5;
          const cr  = canopyR * (0.65 + rng() * 0.55);
          ctx.fillStyle = `rgba(8,20,7,${0.82 + rng() * 0.14})`;
          ctx.beginPath();
          ctx.arc(cx2, cy2, cr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ── Shadow warm-up ────────────────────────────────────────────────────────

  #warmUpShadow() {
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

  // ── Avatar image ──────────────────────────────────────────────────────────

  #loadAvatarImg() {
    const img = new Image();
    img.onload = () => {
      this.#avatarImg       = img;
      this.#avatarImgLoaded = true;
      this.#avatarAspect    = img.naturalWidth / img.naturalHeight;
    };
    img.src = this.#scene.avatarSrc;
  }

  #drawAvatar(ctx, screenX, screenY, heightPx, tilt = 0) {
    const w = heightPx * this.#avatarAspect;
    const h = heightPx;
    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(tilt);
    if (this.#avatarImgLoaded) {
      ctx.drawImage(this.#avatarImg, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = 'rgba(255,220,120,0.85)';
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  #drawItems(ctx, w, h, topPad, playH, items) {
    const si   = this.#scene.item;
    const size = CONFIG.ITEM_SIZE_RATIO * h;

    for (const item of items) {
      if (item.xRatio < -0.15 || item.xRatio > 1.15) continue;
      const sx = item.xRatio * w;
      const sy = topPad + (1 - item.normY) * playH;

      if (item.collectT != null) {
        const t     = clamp(item.collectT / 0.45, 0, 1);
        const alpha = 1 - t;
        const scale = 1 + 0.6 * easeOut(t);
        this.#drawItemShape(ctx, sx, sy, size * scale, alpha, si.collectColor, si.glowColor, si.shape);
      } else if (item.missT != null) {
        const alpha = clamp(1 - item.missT / 0.5, 0, 1);
        this.#drawItemShape(ctx, sx, sy, size, alpha, si.missColor, si.missColor, si.shape);
      } else {
        this.#drawItemShape(ctx, sx, sy, size, 1, si.color, si.glowColor, si.shape);
      }
    }
  }

  #drawItemShape(ctx, cx, cy, size, alpha, color, glowColor, shape) {
    if (shape === 'fruit') {
      this.#drawFruit(ctx, cx, cy, size, alpha, color, glowColor);
    } else {
      this.#drawStar(ctx, cx, cy, size, alpha, color);
    }
  }

  // 5-pointed star
  #drawStar(ctx, cx, cy, r, alpha, color) {
    const ri   = r * 0.42;
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

  // Fruit (circle + stem) for jungle scene
  #drawFruit(ctx, cx, cy, r, alpha, color, glowColor) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = color;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = '#4a7a20';
    ctx.lineWidth   = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.45, cy - r * 1.55);
    ctx.stroke();
    ctx.restore();
  }

  // ── Target curve ──────────────────────────────────────────────────────────

  #drawCurve(ctx, w, h, topPad, playH, blockTime, bpm, scrollSpeed) {
    const period = 60 / bpm;
    ctx.save();
    ctx.beginPath();
    for (let px = 0; px <= w; px += 4) {
      const tOff  = (px / w - CONFIG.AVATAR_X_RATIO) / scrollSpeed;
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

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(barRight - barMaxW, barY, barMaxW, barH, 4);
    ctx.fill();

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

      ctx.fillStyle = 'rgba(0,0,0,0.48)';
      ctx.beginPath();
      ctx.roundRect(cx, cy, cardW, cardH, 6);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(cx, cy, cardW, cardH, 6);
      ctx.clip();

      const t = easeOut(clamp(d.animT, 0, 1));
      if (d.animT < 1) {
        const oldY = cy - t * cardH;
        this.#drawDigitChar(ctx, String(d.from), cx, oldY, cardW, cardH, 1 - t);
        const newY = cy + (1 - t) * cardH;
        this.#drawDigitChar(ctx, String(d.to), cx, newY, cardW, cardH, t);
      } else {
        this.#drawDigitChar(ctx, String(d.shown), cx, cy, cardW, cardH, 1);
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(cx,         cy + cardH / 2);
      ctx.lineTo(cx + cardW, cy + cardH / 2);
      ctx.stroke();

      ctx.restore();
    }

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

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 5;
    ctx.stroke();

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
    const bobNormY    = 0.5 + 0.25 * Math.sin(now / 1000 * 1.5);
    const tilt        = -0.2 * Math.cos(now / 1000 * 1.5);
    const topPad      = h * 0.10;
    const playH       = h * 0.80;
    const avatarScreenX = w / 2;
    const avatarScreenY = topPad + (1 - bobNormY) * playH;
    const avatarH = CONFIG.AVATAR_SIZE_MIN * h + (CONFIG.AVATAR_SIZE_MAX - CONFIG.AVATAR_SIZE_MIN) * h * 0.5;
    this.#drawAvatar(ctx, avatarScreenX, avatarScreenY, avatarH * 1.3, tilt);
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
      avatarNormY, avatarStressNorm = 0.5, avatarTilt = 0, avatarBumpT,
      items, particles, score, blockTime, bpm, showCurve, group, now,
      scrollSpeed, missCount = 0,
    } = data;

    const topPad = h * 0.10;
    const playH  = h * 0.80;
    const normToScreenY = (ny) => topPad + (1 - ny) * playH;

    if (showCurve) {
      this.#drawCurve(ctx, w, h, topPad, playH, blockTime, bpm, scrollSpeed);
    }

    this.#drawItems(ctx, w, h, topPad, playH, items);

    if (particles?.length) {
      this.#drawParticles(ctx, w, h, topPad, playH, particles);
    }

    const avatarScreenX = CONFIG.AVATAR_X_RATIO * w;
    const avatarScreenY = normToScreenY(avatarNormY);
    const baseH = lerp(CONFIG.AVATAR_STRESS_SIZE_MIN, CONFIG.AVATAR_STRESS_SIZE_MAX, avatarStressNorm) * h;
    const bumpScale = avatarBumpT != null
      ? 1 + 0.28 * Math.sin(Math.PI * avatarBumpT / 0.3)
      : 1;
    this.#drawAvatar(ctx, avatarScreenX, avatarScreenY, baseH * bumpScale, avatarTilt);

    if (group === 'slow') {
      this.#drawScoreDisplay(ctx, 18, 16, score, dt);
      this.#drawTimerBar(ctx, w, h, blockTime, now);
    }

    if (missCount > 0) {
      const maxMiss = CONFIG.MISS_GAME_OVER;
      const danger  = missCount / maxMiss;
      const alpha   = 0.30 + 0.55 * danger;
      const r = Math.round(lerp(200, 255, danger));
      const g = Math.round(lerp(200, 80,  danger));
      ctx.fillStyle    = `rgba(${r},${g},80,${alpha})`;
      ctx.font         = '300 13px Nunito, sans-serif';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${missCount} / ${maxMiss} misses`, w - 18, h - 14);
    }
  }

  #drawParticles(ctx, w, h, topPad, playH, particles) {
    ctx.save();
    ctx.shadowBlur = 6;
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

  #drawIntermission(ctx, w, h, score, gameOver = false) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const cy = h / 2;

    const headline      = gameOver ? 'Game 1 over  ·  Too many misses!' : 'Game 1 complete  ·  Good job!';
    const headlineColor = gameOver ? 'rgba(255,140,100,0.90)' : 'rgba(255,255,255,0.85)';
    this.#drawCenter(ctx, w, cy - 80, headline, headlineColor, 30, '300');

    const scoreStr = `★  ${score}  ★`;
    ctx.fillStyle    = '#ffd060';
    ctx.font         = '300 60px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,200,50,0.6)';
    ctx.shadowBlur   = 20;
    ctx.fillText(scoreStr, w / 2, cy);
    ctx.shadowBlur   = 0;

    const label = score === 1 ? '1 item caught' : `${score} items caught`;
    this.#drawCenter(ctx, w, cy + 60, label, 'rgba(255,255,255,0.55)', 18);
    this.#drawCenter(ctx, w, cy + 110, 'Press Space', 'rgba(255,255,255,0.28)', 15);
  }

  #drawDone(ctx, w, h, score1, score2, gameOver = false) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const cy    = h / 2;
    const total = score1 + score2;

    const headline      = gameOver ? 'Game Over' : 'Experiment complete!';
    const headlineColor = gameOver ? 'rgba(255,120,90,0.92)' : 'rgba(255,255,255,0.85)';
    this.#drawCenter(ctx, w, cy - 90, headline, headlineColor, 28, '300');

    ctx.fillStyle    = '#ffd060';
    ctx.font         = '200 72px Nunito, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,200,50,0.55)';
    ctx.shadowBlur   = 22;
    ctx.fillText(`★  ${total}  ★`, w / 2, cy);
    ctx.shadowBlur   = 0;

    this.#drawCenter(ctx, w, cy + 65, `Game 1: ${score1}  ·  Game 2: ${score2}`, 'rgba(255,255,255,0.42)', 16);
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
