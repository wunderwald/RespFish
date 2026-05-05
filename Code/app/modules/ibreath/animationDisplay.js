// Pre-trial display animation: smiling sun with clouds happily bopping side to side.
// Pure function — all animation is derived from t (elapsed seconds since display started).

export function drawDisplay(ctx, w, h, t) {
  const cx   = w / 2;
  const cy   = h / 2;
  const unit = Math.min(w, h);
  const sunR = unit * 0.12;
  const dist = unit * 0.30;

  // Sun drawn first so clouds appear in front
  drawSun(ctx, cx, cy, sunR);

  // Three clouds at different angles, each bopping at a different phase and speed
  const clouds = [
    { angle: -0.55, size: unit * 0.095, phase: 0,                speed: 1.10 },
    { angle:  0.65, size: unit * 0.090, phase: (Math.PI * 2) / 3, speed: 0.95 },
    { angle:  Math.PI + 0.15, size: unit * 0.085, phase: (Math.PI * 4) / 3, speed: 1.25 },
  ];

  for (const c of clouds) {
    const baseX = cx + Math.cos(c.angle) * dist;
    const baseY = cy + Math.sin(c.angle) * dist;
    const θ     = t * c.speed * Math.PI * 2 + c.phase;
    const bopX  = Math.sin(θ) * 14;
    const bopY  = Math.sin(θ + Math.PI / 2) * 5;
    drawCloud(ctx, baseX + bopX, baseY + bopY, c.size, 1);
  }
}

// ── Helpers (ported from trainingGame.js) ────────────────────────────────────

function drawSun(ctx, cx, cy, r) {
  const rayCount = 12;
  ctx.strokeStyle = 'rgba(255,210,50,0.85)';
  ctx.lineWidth   = 5;
  ctx.lineCap     = 'round';
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r * 1.15, cy + Math.sin(angle) * r * 1.15);
    ctx.lineTo(cx + Math.cos(angle) * r * 1.50, cy + Math.sin(angle) * r * 1.50);
    ctx.stroke();
  }

  const grd = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
  grd.addColorStop(0, '#fff7aa');
  grd.addColorStop(1, '#f5c000');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  const eyeOffX = r * 0.28;
  const eyeOffY = r * 0.18;
  const eyeR    = r * 0.09;
  for (const ex of [-eyeOffX, eyeOffX]) {
    ctx.beginPath();
    ctx.arc(cx + ex, cy - eyeOffY, eyeR, 0, Math.PI * 2);
    ctx.fillStyle = '#7a4a00';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.05, r * 0.38, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.strokeStyle = '#7a4a00';
  ctx.lineWidth   = r * 0.08;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

function drawCloud(ctx, x, y, size, alpha) {
  ctx.globalAlpha = alpha;

  const blobs = [
    { dx: 0,            dy: 0,            r: size * 0.55 },
    { dx: -size * 0.42, dy:  size * 0.12, r: size * 0.42 },
    { dx:  size * 0.42, dy:  size * 0.12, r: size * 0.40 },
    { dx: -size * 0.20, dy: -size * 0.28, r: size * 0.34 },
    { dx:  size * 0.22, dy: -size * 0.24, r: size * 0.32 },
  ];

  const grd = ctx.createRadialGradient(x, y - size * 0.15, 0, x, y, size * 0.8);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(210,230,248,0.88)');

  ctx.beginPath();
  for (const b of blobs) {
    ctx.moveTo(x + b.dx + b.r, y + b.dy);
    ctx.arc(x + b.dx, y + b.dy, b.r, 0, Math.PI * 2);
  }
  ctx.fillStyle = grd;
  ctx.fill();

  ctx.globalAlpha = 1;
}
