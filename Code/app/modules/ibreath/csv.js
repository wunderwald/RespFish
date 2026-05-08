// CSV output for the iBreath experiment.
//
// Two files per subject, written to CONFIG.DATA_DIR/<subjectCode>/:
//   trialData.csv   — one row per trial (appended after each trial ends)
//   frameData_N.csv — one row per animation frame for trial N
//
// Columns match the MATLAB ibreath_main_v2.m output exactly.
//
// Strategy:
//   • Subject directory + trialData.csv header are created at calibration
//     start (init()), before any trial runs.
//   • frameData_N.csv header is written when a trial starts (initFrameCSV()),
//     so even a crash mid-trial leaves a valid (partial) file.
//   • Frame rows are buffered during the trial, then flushed as a single
//     write at trial end (flushFrameCSV()). This avoids hundreds of IPC
//     calls per trial while keeping memory bounded.

import { CONFIG } from './config.js';

export class IBreathCSV {
  #subjectCode;
  #group;
  #gazeEnabled;
  #onWarn;
  #frameHeader;
  #trialHeader;

  constructor(subjectCode, group, gazeEnabled, onWarn) {
    this.#subjectCode = subjectCode;
    this.#group       = group;
    this.#gazeEnabled = gazeEnabled;
    this.#onWarn      = onWarn;

    this.#frameHeader =
      'trialIndex,timestamp,breathLevel_input,breathLevel_scaled,stimulusLevel' +
      (CONFIG.FLASHING_IMAGE ? ',flashActive' : '') +
      (gazeEnabled ? ',gazeX,gazeY' : '') + '\n';

    this.#trialHeader =
      'trialIndex,subject,group,questionType,synchronous,img,lr,stimX0,stimY0,stimX1,stimY1,slowfast,' +
      'ITI,startTime,endTime,aborted' +
      (CONFIG.SHOW_QUESTIONS ? ',response' : '') +
      (CONFIG.FLASHING_IMAGE ? ',flashImage,flashScheduledTime,flashX,flashY,flashShown' : '') + '\n';
  }

  async init() {
    if (!window.api) {
      console.warn('[CSV] window.api not available — file I/O disabled');
      return;
    }
    const dir = `${CONFIG.DATA_DIR}/${this.#subjectCode}`;

    const dirResult = await window.api.ensureDir(dir);
    if (!dirResult.ok) {
      this.#warn(`Could not create data dir: ${dirResult.error}`);
      return;
    }

    const trialFile = `${dir}/trialData.csv`;
    const result = await window.api.writeCSV(trialFile, this.#trialHeader);
    if (!result.ok) {
      this.#warn(`Could not init trialData.csv: ${result.error}`);
    } else {
      console.log(`[CSV] initialised ${trialFile}`);
    }
  }

  async initFrameCSV(trialIndex) {
    if (!window.api) return;
    const result = await window.api.writeCSV(
      this.#framePath(trialIndex),
      this.#frameHeader
    );
    if (!result.ok) {
      this.#warn(`Could not init frameData_${trialIndex}.csv: ${result.error}`);
    }
  }

  async flushFrameCSV(trial, frameRows) {
    if (!window.api || frameRows.length === 0) return;

    const rows = frameRows.map(r =>
      `${trial.trialIndex},${r.t},` +
      `${r.raw.toFixed(6)},${r.scaled.toFixed(6)},${r.stim.toFixed(6)}` +
      (CONFIG.FLASHING_IMAGE ? `,${r.flash}` : '') +
      (this.#gazeEnabled ? `,${r.gazeX ?? ''},${r.gazeY ?? ''}` : '')
    ).join('\n') + '\n';

    const result = await window.api.appendCSV(this.#framePath(trial.trialIndex), rows);
    if (!result.ok) {
      this.#warn(`Could not write frameData_${trial.trialIndex}.csv: ${result.error}`);
    } else {
      console.log(`[CSV] wrote ${frameRows.length} frame rows for trial ${trial.trialIndex}`);
    }
  }

  async appendTrialData(trial) {
    if (!window.api) return;

    const row =
      `${trial.trialIndex},` +
      `${this.#subjectCode},` +
      `${this.#group},` +
      `${trial.questionType ?? ''},` +
      `${trial.synchronous},` +
      `${trial.img},` +
      `${trial.lr},` +
      `${trial.stimX0},${trial.stimY0},${trial.stimX1},${trial.stimY1},` +
      `${trial.slowfast ?? ''},` +
      `${trial.ITI},` +
      `${trial.startTime ?? ''},` +
      `${trial.endTime ?? ''},` +
      `${trial.aborted}` +
      (CONFIG.SHOW_QUESTIONS ? `,${trial.response ?? ''}` : '') +
      (CONFIG.FLASHING_IMAGE
        ? `,${trial.flashImage ?? ''},${trial.flashTime ?? ''},` +
        `${trial.flashX ?? ''},${trial.flashY ?? ''},${trial.flashShown}`
        : '') + '\n';

    const result = await window.api.appendCSV(
      `${CONFIG.DATA_DIR}/${this.#subjectCode}/trialData.csv`,
      row
    );
    if (!result.ok) {
      this.#warn(`Could not append to trialData.csv: ${result.error}`);
    }
  }

  #framePath(trialIndex) {
    return `${CONFIG.DATA_DIR}/${this.#subjectCode}/frameData_${trialIndex}.csv`;
  }

  #warn(msg) {
    console.error('[CSV]', msg);
    this.#onWarn(msg);
  }
}
