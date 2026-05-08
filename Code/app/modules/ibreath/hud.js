/**
 * LocalHud — builds the experimenter control bar into a container element
 * and exposes a clean property API so callers never touch the DOM directly.
 *
 * Setters:  stateText, stateColor, trialText,
 *           startEnabled, nextVisible, abortVisible, pauseVisible, inputsLocked, gazeActive
 * Getters:  stateText, subjectCode, questionType
 */
export class LocalHud {
  #stateEl; #trialEl; #subjectInput; #questionTypeSelect;
  #startBtn; #nextBtn; #abortBtn; #pauseBtn; #playBtn;

  constructor(container, subjectCode, { onStart, onNext, onAbort, onPause, onPlay }) {
    container.innerHTML = `
      <span id="ib-state-text">waiting for stream…</span>
      <span>
        <span class="label">trial</span>
        <span id="ib-trial">—</span>
      </span>
      <span>
        <span class="label">subject</span>
        <input id="ib-subject" type="text" value="${subjectCode}"
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
        <button id="ib-pause-btn"  style="display:none">Pause</button>
        <button id="ib-play-btn"   style="display:none">Play</button>
      </span>
    `;

    this.#stateEl            = container.querySelector('#ib-state-text');
    this.#trialEl            = container.querySelector('#ib-trial');
    this.#subjectInput       = container.querySelector('#ib-subject');
    this.#questionTypeSelect = container.querySelector('#ib-question-type');
    this.#startBtn           = container.querySelector('#ib-start-btn');
    this.#nextBtn            = container.querySelector('#ib-next-btn');
    this.#abortBtn           = container.querySelector('#ib-abort-btn');
    this.#pauseBtn           = container.querySelector('#ib-pause-btn');
    this.#playBtn            = container.querySelector('#ib-play-btn');

    this.#startBtn.addEventListener('click', onStart);
    this.#nextBtn.addEventListener('click',  onNext);
    this.#abortBtn.addEventListener('click', onAbort);
    this.#pauseBtn.addEventListener('click', onPause ?? (() => {}));
    this.#playBtn.addEventListener('click',  onPlay  ?? (() => {}));
  }

  get stateText()      { return this.#stateEl.textContent; }
  set stateText(v)     { this.#stateEl.textContent = v; }
  set stateColor(v)    { this.#stateEl.style.color = v ?? ''; }
  set trialText(v)     { this.#trialEl.textContent = v; }
  set startEnabled(v)  { this.#startBtn.disabled = !v; }
  set nextVisible(v)   { this.#nextBtn.style.display  = v ? '' : 'none'; }
  set abortVisible(v)  { this.#abortBtn.style.display = v ? '' : 'none'; }
  set pauseVisible(v)  { this.#pauseBtn.style.display = v ? '' : 'none'; }
  set playVisible(v)   { this.#playBtn.style.display  = v ? '' : 'none'; }
  set inputsLocked(v)  {
    this.#subjectInput.disabled       = v;
    this.#questionTypeSelect.disabled = v;
  }
  set experimentStartedAt(_v) {}
  set stateTimer(_v) {}
  set gazeActive(_v) {}   // no gaze button in local HUD
  get subjectCode()    { return this.#subjectInput.value.trim() || 'TEST'; }
  get questionType()   { return this.#questionTypeSelect.value; }
}
