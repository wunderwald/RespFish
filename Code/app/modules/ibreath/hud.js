/**
 * buildHUD — constructs the experimenter control bar.
 *
 * Returns an object with refs to each interactive element so the caller
 * can update text and toggle visibility without touching the DOM directly.
 */
export function buildHUD(container, subjectCode, { onStart, onNext, onAbort }) {
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
      <select id="ib-question-type">
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

  const stateEl = container.querySelector('#ib-state-text');
  const trialEl = container.querySelector('#ib-trial');
  const subjectInput         = container.querySelector('#ib-subject');
  const questionTypeSelect   = container.querySelector('#ib-question-type');
  const startBtn             = container.querySelector('#ib-start-btn');
  const nextBtn          = container.querySelector('#ib-next-btn');
  const abortBtn         = container.querySelector('#ib-abort-btn');

  startBtn.addEventListener('click', onStart);
  nextBtn.addEventListener('click', onNext);
  abortBtn.addEventListener('click', onAbort);

  return { stateEl, trialEl, subjectInput, questionTypeSelect, startBtn, nextBtn, abortBtn };
}
