// Experimenter control window — stream selection + frontend-specific controls.
import { StreamManager } from './modules/stream/stream.js';
import { CONFIG }        from './modules/ibreath/config.js';
import { CONFIG as BG }  from './modules/bioGame/bioGame_config.js';

// ── Frontend detection ────────────────────────────────────────────────────────

const frontend = new URLSearchParams(location.search).get('frontend') || 'ibreath';

// ── Resp stream (always) ──────────────────────────────────────────────────────

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

// ── Gaze stream (ibreath + gazetest only) ─────────────────────────────────────

let gazeStream = null;
if (['ibreath', 'gazetest'].includes(frontend)) {
  gazeStream = new StreamManager({
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
} else {
  document.getElementById('gaze-bar').style.display = 'none';
}

// ── Timer bar (ibreath only) ──────────────────────────────────────────────────

if (frontend !== 'ibreath') {
  document.getElementById('timer-bar').style.display = 'none';
}

// ── Settings bar (ibreath + bioGame) ─────────────────────────────────────────

const settingsBar = document.getElementById('settings-bar');

if (!['ibreath', 'bioGame'].includes(frontend)) {
  settingsBar.style.display = 'none';
}

// ── Log bar (trainingGame only) ───────────────────────────────────────────────

const logBar = document.getElementById('log-bar');

if (frontend !== 'trainingGame') {
  logBar.style.display = 'none';
}

// ── Frontend-specific stats section ──────────────────────────────────────────

const statsEl = document.getElementById('stats');

if (frontend === 'ibreath') {
  // ── iBreath HUD ─────────────────────────────────────────────────────────────

  statsEl.innerHTML = `
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

  // ── iBreath settings bar ────────────────────────────────────────────────────

  settingsBar.innerHTML = `
    <span class="label">settings</span>
    <label><input type="checkbox" id="s-debug-gaze"   ${CONFIG.DEBUG_GAZE    ? 'checked' : ''}> show gaze position</label>
    <label><input type="checkbox" id="s-auto-advance" ${CONFIG.AUTO_ADVANCE  ? 'checked' : ''}> auto-advance trials</label>
    <label><input type="checkbox" id="s-flash-images" ${CONFIG.FLASHING_IMAGE ? 'checked' : ''}> include flash images</label>
    <span class="label">cal secs</span>
    <input id="s-cal-secs" type="number" class="settings-num" min="5" max="120" step="5"
           value="${CONFIG.CALIBRATION_SECS}" />
    <span class="label">data dir</span>
    <span id="s-data-dir-text">${CONFIG.DATA_DIR}</span>
    <button id="s-pick-dir">…</button>
  `;

  document.getElementById('s-pick-dir').addEventListener('click', async () => {
    const picked = await window.api.pickDir();
    if (picked) document.getElementById('s-data-dir-text').textContent = picked;
  });

  const stateEl            = document.getElementById('ib-state-text');   // in #timer-bar
  const elapsedEl          = document.getElementById('ib-elapsed');       // in #timer-bar
  const remainingEl        = document.getElementById('ib-remaining');     // in #timer-bar
  const trialEl            = document.getElementById('ib-trial');
  const subjectInput       = document.getElementById('ib-subject');
  const questionTypeSelect = document.getElementById('ib-question-type');
  const startBtn           = document.getElementById('ib-start-btn');
  const nextBtn            = document.getElementById('ib-next-btn');
  const abortBtn           = document.getElementById('ib-abort-btn');

  // ── Clocks ──────────────────────────────────────────────────────────────────

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

  // ── Receive state from scene window ─────────────────────────────────────────

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
      subjectInput.disabled       = inputsLocked;
      questionTypeSelect.disabled = inputsLocked;
      if (inputsLocked) {
        respStream.disable();
        gazeStream?.disable();
        for (const el of settingsBar.querySelectorAll('input, button, select')) {
          el.disabled = true;
        }
      }
    }
  });

  // ── Send actions to scene window ─────────────────────────────────────────────

  startBtn.addEventListener('click', () => {
    window.api.hud.sendAction({
      type:            'start',
      subjectCode:     subjectInput.value.trim() || 'TEST',
      questionType:    questionTypeSelect.value,
      debugGaze:       document.getElementById('s-debug-gaze').checked,
      autoAdvance:     document.getElementById('s-auto-advance').checked,
      flashingImage:   document.getElementById('s-flash-images').checked,
      dataDir:         document.getElementById('s-data-dir-text').textContent,
      calibrationSecs: parseInt(document.getElementById('s-cal-secs').value) || CONFIG.CALIBRATION_SECS,
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

  // ── Request current HUD state on load ────────────────────────────────────────

  window.api.hud.sendAction({ type: 'ready' });

} else if (frontend === 'trainingGame') {
  // ── Game controls ────────────────────────────────────────────────────────────

  statsEl.innerHTML = `
    <span id="fe-state">waiting for stream…</span>
    <span><span class="label">score</span><span id="fe-score">—</span></span>
    <span id="ib-controls"><button id="fe-start-btn" disabled>Start</button></span>
  `;
  const feStateEl  = document.getElementById('fe-state');
  const feScoreEl  = document.getElementById('fe-score');
  const feStartBtn = document.getElementById('fe-start-btn');

  feStartBtn.addEventListener('click', () => window.api.frontend.sendAction({ type: 'start' }));

  window.api.frontend.onState(({ stateText, score, btnEnabled, btnText, debugLog }) => {
    if (stateText  !== undefined) feStateEl.textContent  = stateText;
    if (score      !== null && score !== undefined) feScoreEl.textContent = score;
    if (btnEnabled !== undefined) feStartBtn.disabled    = !btnEnabled;
    if (btnText    !== undefined) feStartBtn.textContent = btnText;
    if (debugLog   !== undefined) logBar.textContent     = debugLog ?? '';
  });

} else if (frontend === 'visualizer') {
  // ── Visualizer status ────────────────────────────────────────────────────────

  statsEl.innerHTML = `
    <span><span id="v-status-dot"></span><span id="v-status-text">connecting…</span></span>
    <span><span class="label">value</span><span id="v-val">—</span></span>
    <span><span class="label">samples/s</span><span id="v-sps">—</span></span>
  `;
  const vDotEl  = document.getElementById('v-status-dot');
  const vTextEl = document.getElementById('v-status-text');
  const vValEl  = document.getElementById('v-val');
  const vSpsEl  = document.getElementById('v-sps');

  window.api.frontend.onState(({ dotClass, statusText, value, sps }) => {
    if (dotClass   !== undefined) vDotEl.className    = dotClass;
    if (statusText !== undefined) vTextEl.textContent = statusText;
    if (value      !== undefined && value !== null) vValEl.textContent = value;
    if (sps        !== undefined) vSpsEl.textContent  = sps;
  });

} else if (frontend === 'gazetest') {
  // ── Gazetest stats ───────────────────────────────────────────────────────────

  statsEl.innerHTML = `
    <span><span class="label">gaze</span><span id="gt-gaze-status">—</span></span>
    <span><span class="label">position</span><span id="gt-coords">—</span></span>
    <span><span class="label">accuracy</span><span id="gt-accuracy">—</span></span>
    <span><span class="label">samples/s</span><span id="gt-sps">—</span></span>
    <span><span class="label">stream</span><span id="gt-stream">—</span></span>
  `;
  const gtGazeEl   = document.getElementById('gt-gaze-status');
  const gtCoordsEl = document.getElementById('gt-coords');
  const gtAccEl    = document.getElementById('gt-accuracy');
  const gtSpsEl    = document.getElementById('gt-sps');
  const gtStreamEl = document.getElementById('gt-stream');

  window.api.frontend.onState(({ gazeActive, coords, accuracy, sps, streamStatus }) => {
    if (gazeActive !== undefined) {
      gtGazeEl.textContent = gazeActive ? 'active' : 'inactive';
      gtGazeEl.style.color = gazeActive ? 'rgba(91,201,138,0.9)' : 'rgba(224,120,120,0.8)';
    }
    if (coords       !== undefined) gtCoordsEl.textContent = coords;
    if (accuracy     !== undefined) gtAccEl.textContent    = accuracy;
    if (sps          !== undefined) gtSpsEl.textContent    = sps;
    if (streamStatus !== undefined) gtStreamEl.textContent = streamStatus;
  });

} else if (frontend === 'bioGame') {
  // ── BioGame HUD ──────────────────────────────────────────────────────────────

  statsEl.innerHTML = `
    <span>
      <span class="label">status</span>
      <span id="bg-status">waiting for stream…</span>
    </span>
    <span>
      <span class="label">subject</span>
      <input id="bg-subject" type="text" value="${BG.SUBJECT_CODE}"
             placeholder="subject code" autocomplete="off" spellcheck="false" />
    </span>
    <span>
      <span class="label">group</span>
      <select id="bg-group" class="stream-select">
        <option value="slow">Target (slow 6 BPM)</option>
        <option value="natural">Control (natural)</option>
      </select>
    </span>
    <span id="bg-natural-bpm-wrap">
      <span class="label">natural BPM</span>
      <input id="bg-natural-bpm" type="number" min="4" max="20" step="0.5"
             value="${BG.NATURAL_BPM}" style="width:46px" />
    </span>
    <span>
      <span class="label">score</span>
      <span id="bg-score">—</span>
    </span>
    <span id="ib-controls">
      <button id="bg-start-btn"  disabled>Start</button>
      <button id="bg-next-btn"   style="display:none">Start Game 2</button>
      <button id="bg-abort-btn"  style="display:none">Abort</button>
    </span>
  `;

  // ── bioGame settings bar ──────────────────────────────────────────────────────

  settingsBar.innerHTML = `
    <span class="label">settings</span>
    <label><input type="checkbox" id="bg-show-curve" ${BG.SHOW_CURVE ? 'checked' : ''}>
      show target curve</label>
    <span class="label">cal secs</span>
    <input id="bg-cal-secs" type="number" class="settings-num" min="5" max="120" step="5"
           value="${BG.CALIBRATION_SECS}" />
    <span class="label">data dir</span>
    <span id="bg-data-dir-text">${BG.DATA_DIR}</span>
    <button id="bg-pick-dir">…</button>
  `;

  document.getElementById('bg-pick-dir').addEventListener('click', async () => {
    const picked = await window.api.pickDir();
    if (picked) document.getElementById('bg-data-dir-text').textContent = picked;
  });

  const bgStatusEl   = document.getElementById('bg-status');
  const bgSubjectEl  = document.getElementById('bg-subject');
  const bgGroupEl    = document.getElementById('bg-group');
  const bgNatBpmWrap = document.getElementById('bg-natural-bpm-wrap');
  const bgNatBpmEl   = document.getElementById('bg-natural-bpm');
  const bgScoreEl    = document.getElementById('bg-score');
  const bgStartBtn   = document.getElementById('bg-start-btn');
  const bgNextBtn    = document.getElementById('bg-next-btn');
  const bgAbortBtn   = document.getElementById('bg-abort-btn');

  // Show natural-BPM field only for the natural condition
  bgNatBpmWrap.style.display = BG.GROUP === 'natural' ? '' : 'none';
  bgGroupEl.addEventListener('change', () => {
    bgNatBpmWrap.style.display = bgGroupEl.value === 'natural' ? '' : 'none';
  });

  // ── Receive state from scene window ─────────────────────────────────────────

  window.api.frontend.onState(({ stateText, score, startEnabled, startText,
                                  nextVisible, abortVisible, inputsLocked }) => {
    if (stateText    !== undefined) bgStatusEl.textContent      = stateText;
    if (score        != null)       bgScoreEl.textContent       = score;
    if (startEnabled !== undefined) bgStartBtn.disabled         = !startEnabled;
    if (startText    !== undefined) bgStartBtn.textContent      = startText;
    if (nextVisible  !== undefined) bgNextBtn.style.display     = nextVisible  ? '' : 'none';
    if (abortVisible !== undefined) bgAbortBtn.style.display    = abortVisible ? '' : 'none';
    if (inputsLocked !== undefined && inputsLocked) {
      bgSubjectEl.disabled = true;
      bgGroupEl.disabled   = true;
      bgNatBpmEl.disabled  = true;
      respStream.disable();
      for (const el of settingsBar.querySelectorAll('input, button, select')) {
        el.disabled = true;
      }
    }
  });

  // ── Send actions to scene window ─────────────────────────────────────────────

  bgStartBtn.addEventListener('click', () => {
    window.api.frontend.sendAction({
      type:            'start',
      subjectCode:     bgSubjectEl.value.trim() || 'TEST',
      group:           bgGroupEl.value,
      naturalBpm:      parseFloat(bgNatBpmEl.value) || BG.NATURAL_BPM,
      showCurve:       document.getElementById('bg-show-curve').checked,
      dataDir:         document.getElementById('bg-data-dir-text').textContent,
      calibrationSecs: parseInt(document.getElementById('bg-cal-secs').value) || BG.CALIBRATION_SECS,
    });
  });
  bgNextBtn.addEventListener('click',  () => window.api.frontend.sendAction({ type: 'next' }));
  bgAbortBtn.addEventListener('click', () => window.api.frontend.sendAction({ type: 'abort' }));

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === bgSubjectEl) return;
    switch (e.code) {
      case 'Space':  e.preventDefault(); window.api.frontend.sendAction({ type: 'next' });  break;
      case 'Escape': window.api.frontend.sendAction({ type: 'abort' }); break;
    }
  });

  // ── Request current state on load ─────────────────────────────────────────────

  window.api.frontend.sendAction({ type: 'ready' });

} else {
  statsEl.style.display = 'none';
}
