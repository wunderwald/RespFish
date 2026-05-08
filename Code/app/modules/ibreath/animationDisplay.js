// Pre-trial display animation: three fish bopping happily around the centre.
// Pure function — all animation is derived from elapsed (ms since display started).
// images: { pufferfish, starfish, pinkfish } → HTMLImageElement

export function drawDisplay(ctx, w, h, t, images) {
  const cx     = w / 2, cy = h / 2;
  const unit   = Math.min(w, h);
  const orbitR  = unit * 0.20;
  const size    = unit * 0.085;
  const orbitHz = 0.065;   // full formation rotation every ~15 s

  // Each fish has its own bounce speed and amplitude so they feel independent
  const FISH = [
    { key: 'pufferfish', phase: 0,               bopHz: 0.65, ampX: unit * 0.028, ampY: unit * 0.030 },
    { key: 'starfish',   phase: (Math.PI*2) / 3, bopHz: 0.80, ampX: unit * 0.032, ampY: unit * 0.024 },
    { key: 'pinkfish',   phase: (Math.PI*4) / 3, bopHz: 0.95, ampX: unit * 0.025, ampY: unit * 0.034 },
  ];

  for (const { key, phase, bopHz, ampX, ampY } of FISH) {
    const img = images[key];
    if (!img?.complete || img.naturalWidth === 0) continue;

    const orbitAngle = phase + t * orbitHz * Math.PI * 2;

    // Orbit base position + independent x/y bounce (y offset by π*0.65 so axes feel decoupled)
    const bopX = Math.sin(t * bopHz * Math.PI * 2 + phase) * ampX;
    const bopY = Math.sin(t * bopHz * Math.PI * 2 + phase + Math.PI * 0.65) * ampY;

    const x = cx + Math.cos(orbitAngle) * orbitR + bopX;
    const y = cy + Math.sin(orbitAngle) * orbitR + bopY;

    // Combined x velocity decides which way the fish faces
    const orbitVx = -Math.sin(orbitAngle) * orbitHz * Math.PI * 2 * orbitR;
    const bopVx   = Math.cos(t * bopHz * Math.PI * 2 + phase) * ampX * bopHz * Math.PI * 2;
    const facingLeft = (orbitVx + bopVx) < 0;

    // Tail wag at 2× bop frequency in fish-local space
    const wag = Math.sin(t * bopHz * 2 * Math.PI * 2 + phase) * 0.07;

    ctx.save();
    ctx.translate(x, y);
    if (facingLeft) ctx.scale(-1, 1);
    ctx.rotate(wag);
    ctx.drawImage(img, -size, -size, size * 2, size * 2);
    ctx.restore();
  }
}
