// WebSocket client for eyelink_to_lsl/run_bridge.py's control API.
// Bidirectional: sends {"type": "calibrate"|"start"|"stop"|"status"} and
// receives {"type": "status", "state": ..., "recording": bool, ...} broadcasts.

export class EyeLinkControl {
  #ws = null;
  #url;
  #queue = [];
  #connected = false;
  #onStatus;

  constructor(url, { onStatus } = {}) {
    this.#url = url;
    this.#onStatus = onStatus ?? (() => {});
    this.#open();
  }

  get connected() { return this.#connected; }

  calibrate() { this.#send({ type: 'calibrate' }); }
  start()     { this.#send({ type: 'start' }); }
  stop()      { this.#send({ type: 'stop' }); }
  status()    { this.#send({ type: 'status' }); }

  #send(obj) {
    const payload = JSON.stringify(obj);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(payload);
    } else {
      this.#queue.push(payload);
    }
  }

  #open() {
    try {
      this.#ws = new WebSocket(this.#url);
    } catch {
      setTimeout(() => this.#open(), 2000);
      return;
    }
    this.#ws.onopen = () => {
      this.#connected = true;
      for (const m of this.#queue) this.#ws.send(m);
      this.#queue = [];
      console.log('[EyeLinkControl] connected');
    };
    this.#ws.onmessage = ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'status') this.#onStatus(msg);
      else if (msg.type === 'error') console.warn('[EyeLinkControl] error:', msg.message);
    };
    this.#ws.onclose = () => {
      this.#connected = false;
      setTimeout(() => this.#open(), 2000);
    };
    this.#ws.onerror = () => {};
  }
}
