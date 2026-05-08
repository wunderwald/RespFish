// Pre-trial display animation: three fish bopping happily around the centre.
// Pure function — all animation is derived from elapsed (ms since display started).
// images: { pufferfish, starfish, pinkfish } → HTMLImageElement

export function drawDisplay(ctx, w, h, elapsed, images) {
  const t      = elapsed / 1000;
  const cx     = w / 2, cy = h / 2;
  const unit   = Math.min(w, h);
  const orbitR  = unit * 0.20;
  const size    = unit * 0.085;
  const orbitHz = 0.11;    // full formation rotation every ~9 s
  const bopAmp  = unit * 0.022;
  const bopHz   = 1.8;     // bops per second

  const FISH = [
    { key: 'pufferfish', phase: 0 },
    { key: 'starfish',   phase: (Math.PI * 2) / 3 },
    { key: 'pinkfish',   phase: (Math.PI * 4) / 3 },
  ];

  for (const { key, phase } of FISH) {
    const img = images[key];
    if (!img?.complete || img.naturalWidth === 0) continue;

    const orbitAngle = phase + t * orbitHz * Math.PI * 2;

    // Side-to-side bop added to the orbit x position
    const bop = Math.sin(t * bopHz * Math.PI * 2 + phase) * bopAmp;
    const x   = cx + Math.cos(orbitAngle) * orbitR + bop;
    const y   = cy + Math.sin(orbitAngle) * orbitR;

    // Combined x velocity decides which way the fish faces
    const orbitVx = -Math.sin(orbitAngle) * orbitHz * Math.PI * 2 * orbitR;
    const bopVx   = Math.cos(t * bopHz * Math.PI * 2 + phase) * bopAmp * bopHz * Math.PI * 2;
    const facingLeft = (orbitVx + bopVx) < 0;

    // Gentle tail wag at 2× bop frequency in fish-local space
    const wag = Math.sin(t * bopHz * 2 * Math.PI * 2 + phase) * 0.07;

    ctx.save();
    ctx.translate(x, y);
    if (facingLeft) ctx.scale(-1, 1);
    ctx.rotate(wag);
    ctx.drawImage(img, -size, -size, size * 2, size * 2);
    ctx.restore();
  }
}
