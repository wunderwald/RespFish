// Experimenter control window — HUD + stream selection for iBreath.
import { StreamManager } from './modules/stream/stream.js';
import { CONFIG }        from './modules/ibreath/config.js';

// ── Stream selectors ──────────────────────────────────────────────────────────

const respStream = new StreamManager({
  container: document.getElementById('stream-bar'),
  label: 'resp stream',
  filter: 'resp',
});
respStream.on('sample', ({ value, channels }) => {
  window.api.stream.sendSample({ value, channels });
});
respStream.on('status', (event) => {
  window.api.stream.sendStatus(event);
});

const gazeStream = new StreamManager({
  container: document.getElementById('gaze-bar'),
  wsUrl: CONFIG.GAZE_STREAM_URL,
  label: 'gaze stream',
  filter: 'gaze',
});
gazeStream.on('sample', ({ channels }) => {
  window.api.stream.sendGazeSample({ channels });
});
gazeStream.on('status', ({ type }) => {
  if (type === 'disconnected') window.api.stream.sendGazeSample({ channels: null });
});

// ── HUD bar ───────────────────────────────────────────────────────────────────

const container = document.getElementById('stats');
container.innerHTML = `
  <span>
    <span class="label">trial</span>
    <span id="ib-trial">—</span>
  </span>
  <span>
    <span class="label">subject</span>
    <input id="ib-subject" type="text" value="${CONFIG.SUBJECT_CODE}"
           placeholder="subject code" autocomplete="off" spellcheck="false" />
  </span>
  <span>
    <span class="label">group</span>
    <select id="ib-question-type" class="stream-select">
      <option value="intero">Target (intero)</option>
      <option value="extero">Control (extero)</option>
    </select>
  </span>
  <span id="ib-controls">
    <button id="ib-start-btn"  disabled>Start</button>
    <button id="ib-next-btn"   style="display:none">Next trial</button>
    <button id="ib-abort-btn"  style="display:none">Abort trial</button>
  </span>
`;

const stateEl            = document.getElementById('ib-state-text');   // in #timer-bar
const elapsedEl          = document.getElementById('ib-elapsed');       // in #timer-bar
const remainingEl        = document.getElementById('ib-remaining');     // in #timer-bar
const trialEl            = document.getElementById('ib-trial');
const subjectInput       = document.getElementById('ib-subject');
const questionTypeSelect = document.getElementById('ib-question-type');
const startBtn           = document.getElementById('ib-start-btn');
const nextBtn            = document.getElementById('ib-next-btn');
const abortBtn           = document.getElementById('ib-abort-btn');

// ── Clocks ────────────────────────────────────────────────────────────────────

let experimentStartedAt = null;
let stateTimer          = null;   // { startedAt, duration } or null

function fmtTime(secs) {
  if (secs == null) return '—';
  secs = Math.max(0, Math.floor(secs));
  return `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
}

setInterval(() => {
  elapsedEl.textContent   = experimentStartedAt
    ? fmtTime((Date.now() - experimentStartedAt) / 1000)
    : '—';
  remainingEl.textContent = (stateTimer && stateTimer.duration != null)
    ? fmtTime(stateTimer.duration - (Date.now() - stateTimer.startedAt) / 1000)
    : '—';
}, 250);

// ── Receive state from scene window ───────────────────────────────────────────

window.api.hud.onState(({ stateText, stateColor, trialText,
                           startEnabled, nextVisible, abortVisible, inputsLocked,
                           experimentStartedAt: esa, stateTimer: st }) => {
  if (esa !== undefined) experimentStartedAt = esa;
  if (st  !== undefined) stateTimer          = st;
  if (stateText    !== undefined) stateEl.textContent        = stateText;
  if (stateColor   !== undefined) stateEl.style.color        = stateColor;
  if (trialText    !== undefined) trialEl.textContent        = trialText;
  if (startEnabled !== undefined) startBtn.disabled          = !startEnabled;
  if (nextVisible  !== undefined) nextBtn.style.display      = nextVisible  ? '' : 'none';
  if (abortVisible !== undefined) abortBtn.style.display     = abortVisible ? '' : 'none';
  if (inputsLocked !== undefined) {
    subjectInput.disabled        = inputsLocked;
    questionTypeSelect.disabled  = inputsLocked;
    if (inputsLocked) {
      respStream.disable();
      gazeStream.disable();
    }
  }
});

// ── Send actions to scene window ──────────────────────────────────────────────

startBtn.addEventListener('click', () => {
  window.api.hud.sendAction({
    type:         'start',
    subjectCode:  subjectInput.value.trim() || 'TEST',
    questionType: questionTypeSelect.value,
  });
});
nextBtn.addEventListener('click',  () => window.api.hud.sendAction({ type: 'next' }));
abortBtn.addEventListener('click', () => window.api.hud.sendAction({ type: 'abort' }));

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (document.activeElement === subjectInput) return;
  switch (e.code) {
    case 'Space':      e.preventDefault(); window.api.hud.sendAction({ type: 'next' }); break;
    case 'Escape':     window.api.hud.sendAction({ type: 'abort' }); break;
    case 'ArrowLeft':  window.api.hud.sendAction({ type: 'response', value: true });  break;
    case 'ArrowRight': window.api.hud.sendAction({ type: 'response', value: false }); break;
  }
});

// ── Request current HUD state on load ─────────────────────────────────────────

window.api.hud.sendAction({ type: 'ready' });
