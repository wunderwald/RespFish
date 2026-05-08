/**
 * RemoteHud — same property API as LocalHud, backed by IPC.
 *
 * The HUD DOM lives in the experimenter window (experimenter.html).
 * This class runs in the scene window and:
 *   - pushes state snapshots to the experimenter window via hud:state IPC
 *   - receives user actions (start/next/abort/response) from the experimenter
 *     window via hud:action IPC and calls the appropriate callbacks
 */
export class RemoteHud {
  #snap = {
    stateText:           'waiting for stream…',
    stateColor:          '',
    trialText:           '—',
    startEnabled:        false,
    nextVisible:         false,
    abortVisible:        false,
    pauseVisible:        false,
    playVisible:         false,
    inputsLocked:        false,
    experimentStartedAt: null,
    stateTimer:          null,   // { startedAt: Date.now(), duration: seconds | null }
    gazeActive:          false,
  };
  #subjectCode = 'TEST';
  #questionType = 'intero';

  constructor({ onStart, onNext, onAbort, onResponse, onPause, onPlay, onRecalibrateGaze }) {
    window.api.hud.onAction(({ type, subjectCode, questionType, value,
                               debugGaze, autoAdvance, flashingImage, calibrationSecs,
                               showQuestions }) => {
      if (subjectCode  !== undefined) this.#subjectCode  = subjectCode;
      if (questionType !== undefined) this.#questionType = questionType;
      switch (type) {
        case 'start':           onStart({ debugGaze, autoAdvance, flashingImage, calibrationSecs, showQuestions }); break;
        case 'next':            onNext(); break;
        case 'abort':           onAbort(); break;
        case 'response':        onResponse?.(value); break;
        case 'pause':           onPause?.(); break;
        case 'play':            onPlay?.(); break;
        case 'recalibrateGaze': onRecalibrateGaze?.(); break;
        case 'ready':           this.#push(); break;
      }
    });
  }

  get stateText()     { return this.#snap.stateText; }
  set stateText(v)    { this.#snap.stateText    = v;   this.#push(); }
  set stateColor(v)   { this.#snap.stateColor   = v ?? ''; this.#push(); }
  set trialText(v)    { this.#snap.trialText     = v;   this.#push(); }
  set startEnabled(v) { this.#snap.startEnabled  = v;   this.#push(); }
  set nextVisible(v)  { this.#snap.nextVisible   = v;   this.#push(); }
  set abortVisible(v) { this.#snap.abortVisible  = v;   this.#push(); }
  set pauseVisible(v) { this.#snap.pauseVisible  = v;   this.#push(); }
  set playVisible(v)  { this.#snap.playVisible   = v;   this.#push(); }
  set inputsLocked(v) { this.#snap.inputsLocked  = v;   this.#push(); }
  set gazeActive(v)   { this.#snap.gazeActive    = v;   this.#push(); }
  set experimentStartedAt(v) { this.#snap.experimentStartedAt = v; this.#push(); }
  set stateTimer(v)          { this.#snap.stateTimer = v;          this.#push(); }
  get subjectCode()          { return this.#subjectCode; }
  get questionType()         { return this.#questionType; }

  #push() {
    window.api.hud.sendState({ ...this.#snap });
  }
}
