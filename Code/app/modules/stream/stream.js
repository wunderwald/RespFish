/**
 * StreamManager
 * =============
 * Owns the WebSocket connection to the LSL bridge and the stream-selection
 * dropdown.  Everything else in the app subscribes to its events.
 *
 * Events emitted:
 *   'sample'   { value: number, channels: number[], timestamp: number }
 *   'status'   { type: 'connected'|'disconnected'|'searching', text: string,
 *                stream?: object }
 *   'streams'  stream[]   — full list whenever it changes
 *
 * Usage:
 *   const sm = new StreamManager({ container, wsUrl, filter: 'resp' });
 *   sm.on('sample', ({ value, channels }) => ...);
 *   sm.on('status', ({ type, text }) => ...);
 */

export class StreamManager {
  #ws = null;
  #handlers = {};
  #selectedStream = null;
  #streamConnected = false;
  #currentStreams = [];
  #selectEl = null;
  #wsUrl;
  #filter;
  #userSelectedNone = false;  // true once user explicitly picks "— none —"

  constructor({ container, wsUrl = "ws://localhost:8765", label = "stream", filter = null }) {
    this.#wsUrl = wsUrl;
    this.#filter = filter;
    this.#buildUI(container, label);
    this.#connect();
  }

  // public API

  on(event, cb) {
    (this.#handlers[event] ??= []).push(cb);
    return this;
  }

  disable() {
    if (this.#selectEl) this.#selectEl.disabled = true;
  }

  // UI

  #buildUI(container, label) {
    container.innerHTML = `
      <span class="label">${label}</span>
      <select class="stream-select">
        <option value="">— none —</option>
      </select>
    `;
    this.#selectEl = container.querySelector(".stream-select");
    this.#selectEl.addEventListener("change", () => {
      const name = this.#selectEl.value;
      if (!name) {
        this.#userSelectedNone = true;
        this.#selectedStream = null;
        this.#streamConnected = false;
        this.#send({ type: "select_stream", name: null });
        return;
      }
      this.#userSelectedNone = false;
      this.#selectedStream = name;
      this.#streamConnected = false;
      this.#rebuildDropdown();
      this.#send({ type: "select_stream", name });
    });
  }

  #rebuildDropdown() {
    const sel = this.#selectEl;
    const isOffline = this.#selectedStream && !this.#streamConnected;
    sel.innerHTML = "";

    // "— none —" is always the first option
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— none —";
    sel.appendChild(noneOpt);

    if (isOffline) {
      const opt = document.createElement("option");
      opt.value = this.#selectedStream;
      opt.textContent = `${this.#selectedStream} (offline)`;
      opt.dataset.offline = "true";
      sel.appendChild(opt);
    }

    for (const s of this.#currentStreams) {
      if (isOffline && s.name === this.#selectedStream) continue;
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name;
      sel.appendChild(opt);
    }

    if (this.#selectedStream) {
      sel.value = this.#selectedStream;
    } else if (!this.#userSelectedNone && this.#filter && this.#currentStreams.length > 0) {
      const match = this.#currentStreams.find(s =>
        s.name.toLowerCase().includes(this.#filter.toLowerCase()) &&
        !s.name.toLowerCase().includes('markers')
      );
      if (match) {
        sel.value = match.name;
        this.#selectedStream = match.name;
        this.#send({ type: "select_stream", name: match.name });
      }
      // else stays on "— none —"
    }
    // else: stays on "— none —"
  }

  // WebSocket

  #send(obj) {
    if (this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify(obj));
  }

  #emit(event, data) {
    for (const cb of this.#handlers[event] ?? []) cb(data);
  }

  #connect() {
    this.#ws = new WebSocket(this.#wsUrl);

    this.#ws.onopen = () =>
      this.#emit("status", { type: "searching", text: "waiting for stream…" });

    this.#ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case "streams":
          this.#currentStreams = msg.streams;
          this.#rebuildDropdown();
          this.#emit("streams", msg.streams);
          break;

        case "sample":
          this.#emit("sample", { value: msg.value, channels: msg.channels, timestamp: msg.timestamp });
          break;

        case "connected":
          this.#streamConnected = true;
          this.#selectedStream = msg.stream.name;
          this.#rebuildDropdown();
          this.#emit("status", {
            type: "connected",
            text: msg.stream.name,
            stream: msg.stream,
          });
          break;

        case "disconnected":
          this.#streamConnected = false;
          this.#rebuildDropdown();
          this.#emit("status", { type: "disconnected", text: "stream lost…" });
          break;

        case "searching":
          this.#emit("status", { type: "searching", text: "searching…" });
          break;
      }
    };

    this.#ws.onclose = () => {
      this.#streamConnected = false;
      this.#rebuildDropdown();
      this.#emit("status", { type: "disconnected", text: "reconnecting…" });
      setTimeout(() => this.#connect(), 3000);
    };
  }
}
