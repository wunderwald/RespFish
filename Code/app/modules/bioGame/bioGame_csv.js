// CSV output for the bioGame experiment.
//
// Two file types written to dataDir/<subjectCode>/:
//   eventData.csv          — one row per event (session info, state changes, collects, misses)
//   frameData_block0.csv   — 20-fps frame rows for block 0
//   frameData_block1.csv   — 20-fps frame rows for block 1
//
// Frame rows are buffered in memory and flushed every FRAME_FLUSH_COUNT rows
// to avoid high-frequency IPC.

import { CONFIG } from './bioGame_config.js';

export class BioGameCSV {
  #subjectCode;
  #group;
  #dataDir;
  #onWarn;

  #frameBuffer       = [];
  #currentBlockIndex = 0;

  #frameHeader = 'timestamp,blockIndex,breathRaw,breathSmoothed,breathNorm,' +
                 'fishY,targetY,starfishCount\n';
  #eventHeader = 'timestamp,blockIndex,event,value1,value2\n';

  constructor(subjectCode, group, dataDir, onWarn) {
    this.#subjectCode = subjectCode;
    this.#group       = group;
    this.#dataDir     = dataDir;
    this.#onWarn      = onWarn;
  }

  async init() {
    if (!window.api) {
      console.warn('[CSV] window.api unavailable — file I/O disabled');
      return;
    }
    const dir = `${this.#dataDir}/${this.#subjectCode}`;
    const dirResult = await window.api.ensureDir(dir);
    if (!dirResult.ok) { this.#warn(`Could not create data dir: ${dirResult.error}`); return; }

    const evtPath = `${dir}/eventData.csv`;
    const res = await window.api.writeCSV(evtPath, this.#eventHeader);
    if (!res.ok) { this.#warn(`Could not init eventData.csv: ${res.error}`); return; }

    // Write session metadata as the first event row
    const meta = `${new Date().toISOString()},0,session_start,${this.#group},\n`;
    const res2 = await window.api.appendCSV(evtPath, meta);
    if (!res2.ok) this.#warn(`Could not write session_start: ${res2.error}`);
    else console.log(`[CSV] initialised ${evtPath}`);
  }

  async initBlockCSV(blockIndex) {
    if (!window.api) return;
    this.#currentBlockIndex = blockIndex;
    const path = this.#framePath(blockIndex);
    const res  = await window.api.writeCSV(path, this.#frameHeader);
    if (!res.ok) this.#warn(`Could not init ${path}: ${res.error}`);
    else console.log(`[CSV] initialised ${path}`);
  }

  // Buffer a frame row. Call flushFrames() at block end to drain the remainder.
  bufferFrame(row) {
    this.#frameBuffer.push(row);
    if (this.#frameBuffer.length >= CONFIG.FRAME_FLUSH_COUNT) {
      this.flushFrames(this.#currentBlockIndex);
    }
  }

  async flushFrames(blockIndex) {
    if (!window.api || this.#frameBuffer.length === 0) return;
    const buf = this.#frameBuffer;
    this.#frameBuffer = [];

    const csv = buf.map(r =>
      `${r.t},${r.block},${r.raw.toFixed(4)},${r.smoothed.toFixed(4)},` +
      `${r.norm.toFixed(4)},${r.fishY.toFixed(4)},${r.targetY.toFixed(4)},${r.stars}`
    ).join('\n') + '\n';

    const res = await window.api.appendCSV(this.#framePath(blockIndex), csv);
    if (!res.ok) this.#warn(`Could not write frame data: ${res.error}`);
  }

  async appendEvent(blockIndex, event, value1 = '', value2 = '') {
    if (!window.api) return;
    const row = `${new Date().toISOString()},${blockIndex},${event},${value1},${value2}\n`;
    const res = await window.api.appendCSV(
      `${this.#dataDir}/${this.#subjectCode}/eventData.csv`, row
    );
    if (!res.ok) this.#warn(`Could not write event '${event}': ${res.error}`);
  }

  #framePath(blockIndex) {
    return `${this.#dataDir}/${this.#subjectCode}/frameData_block${blockIndex}.csv`;
  }

  #warn(msg) {
    console.error('[CSV]', msg);
    this.#onWarn?.(msg);
  }
}
