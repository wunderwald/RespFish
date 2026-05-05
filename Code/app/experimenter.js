// Experimenter control window — mirrors the iBreath HUD via IPC.

const container = document.getElementById('stats');

container.innerHTML = `
  <span id="ib-state-text">waiting for stream…</span>
  <span>
    <span class="label">trial</span>
    <span id="ib-trial">—</span>
  </span>
  <span>
    <span class="label">subject</span>
    <input id="ib-subject" type="text" value="TEST"
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

const stateEl           = document.getElementById('ib-state-text');
const trialEl           = document.getElementById('ib-trial');
const subjectInput      = document.getElementById('ib-subject');
const questionTypeSelect = document.getElementById('ib-question-type');
const startBtn          = document.getElementById('ib-start-btn');
const nextBtn           = document.getElementById('ib-next-btn');
const abortBtn          = document.getElementById('ib-abort-btn');

// ── Receive state from scene window ───────────────────────────────────────────

window.api.hud.onState(({ stateText, stateColor, trialText,
                           startEnabled, nextVisible, abortVisible, inputsLocked }) => {
  if (stateText    !== undefined) stateEl.textContent       = stateText;
  if (stateColor   !== undefined) stateEl.style.color       = stateColor;
  if (trialText    !== undefined) trialEl.textContent       = trialText;
  if (startEnabled !== undefined) startBtn.disabled         = !startEnabled;
  if (nextVisible  !== undefined) nextBtn.style.display     = nextVisible  ? '' : 'none';
  if (abortVisible !== undefined) abortBtn.style.display    = abortVisible ? '' : 'none';
  if (inputsLocked !== undefined) {
    subjectInput.disabled       = inputsLocked;
    questionTypeSelect.disabled = inputsLocked;
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

// ── Request current state on load ─────────────────────────────────────────────

window.api.hud.sendAction({ type: 'ready' });
