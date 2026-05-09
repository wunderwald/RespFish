import { CONFIG }      from '../modules/trainingGame/trainingGame_config.js';
import { TrainingGame } from '../modules/trainingGame/trainingGame.js';
import { MicInput }     from './micInput.js';

// ── DOM ───────────────────────────────────────────────────────────────────────
const scene = document.getElementById('scene');
const btn   = document.getElementById('hud-btn');

// ── window.api shim ───────────────────────────────────────────────────────────
// Provides the same interface the Electron renderer expects, backed by DOM.
let _actionCb = null;
window.api = {
  frontend: {
    onAction:  cb => { _actionCb = cb; },
    sendState: ({ btnEnabled, btnText } = {}) => {
      if (btnEnabled != null) btn.disabled    = !btnEnabled;
      if (btnText    != null) btn.textContent = btnText;
    },
  },
};

// ── Calibration canvas ────────────────────────────────────────────────────────
const calCanvas = document.createElement('canvas');
calCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
let calCtx;

function resizeCal() {
  calCanvas.width  = calCanvas.offsetWidth  || window.innerWidth;
  calCanvas.height = calCanvas.offsetHeight || window.innerHeight;
}

// ── Calibration drawing ───────────────────────────────────────────────────────
// Mirrors TrainingGameRenderer#drawSun so calibration and game feel continuous.
function drawSun(ctx, cx, cy, r, sadness) {
  ctx.strokeStyle = 'rgba(255,210,50,0.85)';
  ctx.lineWidth   = 5;
  ctx.lineCap     = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 1.15, cy + Math.sin(a) * r * 1.15);
    ctx.lineTo(cx + Math.cos(a) * r * 1.50, cy + Math.sin(a) * r * 1.50);
    ctx.stroke();
  }

  const grd = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
  grd.addColorStop(0, '#fff7aa');
  grd.addColorStop(1, '#f5c000');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  const eX = r * 0.28, eY = r * 0.18, eR = r * 0.09;
  for (const ex of [-eX, eX]) {
    ctx.beginPath();
    ctx.arc(cx + ex, cy - eY, eR, 0, Math.PI * 2);
    ctx.fillStyle = '#7a4a00';
    ctx.fill();
  }

  const mW = r * 0.38, mY = cy + r * 0.38;
  ctx.beginPath();
  ctx.moveTo(cx - mW, mY);
  ctx.quadraticCurveTo(cx, mY + r * 0.35 * (1 - 2 * sadness), cx + mW, mY);
  ctx.strokeStyle = '#7a4a00';
  ctx.lineWidth   = r * 0.08;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

function drawCalFrame({ message, subMessage = '', progress = -1, phase = 'intro', micLevel = 0, round = 0 }) {
  resizeCal();
  const w = calCanvas.width, h = calCanvas.height;
  const cx = w / 2;

  const sky = calCtx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0,   '#8bbfe0');
  sky.addColorStop(0.5, '#c2dff2');
  sky.addColorStop(1,   '#daeefa');
  calCtx.fillStyle = sky;
  calCtx.fillRect(0, 0, w, h);

  const r     = CONFIG.SUN_RADIUS;
  const sunY  = h * 0.38;
  const sadness = phase === 'breath'
    ? Math.max(0, 1 - micLevel / (CONFIG.CAL_FALLBACK_CEIL * 0.7))
    : phase === 'done' ? 0 : 0.4;
  drawSun(calCtx, cx, sunY, r, sadness);

  const textY = sunY + r + 48;
  calCtx.save();
  calCtx.textAlign    = 'center';
  calCtx.textBaseline = 'middle';
  calCtx.shadowColor  = 'rgba(0,0,0,0.22)';
  calCtx.shadowBlur   = 6;
  calCtx.fillStyle    = 'rgba(255,255,255,0.95)';
  calCtx.font         = `300 ${Math.round(Math.max(22, w * 0.038))}px Nunito, sans-serif`;
  calCtx.fillText(message, cx, textY);
  if (subMessage) {
    calCtx.fillStyle = 'rgba(255,255,255,0.55)';
    calCtx.font      = `200 ${Math.round(Math.max(14, w * 0.024))}px Nunito, sans-serif`;
    calCtx.fillText(subMessage, cx, textY + Math.max(30, w * 0.048));
  }
  calCtx.restore();

  if (progress >= 0) {
    const bW = Math.min(280, w * 0.48), bH = 8;
    const bX = cx - bW / 2, bY = textY + Math.max(56, w * 0.09);
    calCtx.fillStyle = 'rgba(255,255,255,0.2)';
    calCtx.beginPath();
    calCtx.roundRect(bX, bY, bW, bH, 4);
    calCtx.fill();
    calCtx.fillStyle = phase === 'breath' ? 'rgba(255,220,80,0.88)' : 'rgba(200,230,255,0.75)';
    calCtx.beginPath();
    calCtx.roundRect(bX, bY, bW * progress, bH, 4);
    calCtx.fill();
  }

  // Round progress dots
  const dotR = 6, dotGap = 22;
  const dotsW = (CONFIG.CAL_ROUNDS - 1) * dotGap;
  for (let i = 0; i < CONFIG.CAL_ROUNDS; i++) {
    calCtx.beginPath();
    calCtx.arc(cx - dotsW / 2 + i * dotGap, h - 42, dotR, 0, Math.PI * 2);
    calCtx.fillStyle = i < round
      ? 'rgba(255,255,255,0.85)'
      : i === round
        ? 'rgba(255,220,80,0.90)'
        : 'rgba(255,255,255,0.25)';
    calCtx.fill();
  }
}

// ── Calibration logic ─────────────────────────────────────────────────────────
function calPhase({ round, phase, durationMs, message, subMessage }, mic) {
  return new Promise(resolve => {
    const samples = [];
    const start   = performance.now();

    function frame() {
      const elapsed  = performance.now() - start;
      const progress = Math.min(elapsed / durationMs, 1);
      const micLevel = mic.getRaw();
      samples.push(micLevel);
      drawCalFrame({ message, subMessage, progress, phase, micLevel, round });
      if (progress < 1) requestAnimationFrame(frame);
      else              resolve(samples);
    }
    requestAnimationFrame(frame);
  });
}

function staticFrame(opts, durationMs) {
  return new Promise(resolve => {
    const start = performance.now();
    function frame() {
      drawCalFrame(opts);
      if (performance.now() - start < durationMs) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

async function calibrate(mic) {
  scene.appendChild(calCanvas);
  calCtx = calCanvas.getContext('2d');
  window.addEventListener('resize', resizeCal);
  resizeCal();

  await staticFrame(
    { message: "Let's set up the mic!", subMessage: 'Get ready…', phase: 'intro', round: 0 },
    1400,
  );

  const floors = [], ceils = [];
  const avg    = arr => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
  const sleep  = ms  => new Promise(r => setTimeout(r, ms));

  for (let round = 0; round < CONFIG.CAL_ROUNDS; round++) {
    const silenceSamples = await calPhase({
      round,
      phase:      'silence',
      durationMs: CONFIG.CAL_SILENCE_MS,
      message:    'Shhh... 🤫',
      subMessage: `Round ${round + 1} of ${CONFIG.CAL_ROUNDS} — stay as quiet as possible`,
    }, mic);
    floors.push(avg(silenceSamples));

    await sleep(250);

    const breathSamples = await calPhase({
      round,
      phase:      'breath',
      durationMs: CONFIG.CAL_BREATH_MS,
      message:    'Blow! 💨',
      subMessage: `Round ${round + 1} of ${CONFIG.CAL_ROUNDS} — blow steadily into the mic`,
    }, mic);
    ceils.push(Math.max(...breathSamples));

    if (round < CONFIG.CAL_ROUNDS - 1) await sleep(500);
  }

  await staticFrame(
    { message: '✓ All done!', subMessage: 'Starting game…', phase: 'done', round: CONFIG.CAL_ROUNDS },
    900,
  );

  window.removeEventListener('resize', resizeCal);

  const floor = median(floors);
  const ceil  = median(ceils);
  const valid = ceil >= floor * CONFIG.CAL_MIN_RATIO;
  console.log(`[Calibration] floor=${floor.toFixed(4)} ceil=${ceil.toFixed(4)} valid=${valid}`);

  return valid
    ? { floor, ceil }
    : { floor: CONFIG.CAL_FALLBACK_FLOOR, ceil: CONFIG.CAL_FALLBACK_CEIL };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const mic = new MicInput();

btn.textContent = 'Tap to start';
btn.disabled    = false;

btn.addEventListener('click', async () => {
  btn.disabled = true;

  try {
    await mic.init();
  } catch {
    btn.textContent = 'Microphone access needed — please allow and reload';
    btn.disabled    = false;
    return;
  }

  btn.classList.add('hidden');

  const { floor, ceil } = await calibrate(mic);
  mic.setCalibration(floor, ceil);

  // TrainingGame replaces scene content with its own canvas on construction
  const game = new TrainingGame({ statsContainer: null, sceneContainer: scene });
  game.setStatus({ type: 'connected' });

  btn.classList.remove('hidden');
  btn.addEventListener('click', () => _actionCb?.({ type: 'start' }));

  mic.start(norm => game.pushSample(norm));
}, { once: true });
