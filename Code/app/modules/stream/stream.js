/**
 * StreamManager
 * =============
 * Owns the WebSocket connection to the LSL bridge and the stream-selection
 * dropdown.  Everything else in the app subscribes to its events.
 *
 * Events emitted:
 *   'sample'   { value: number, timestamp: number }
 *   'status'   { type: 'connected'|'disconnected'|'searching', text: string,
 *                stream?: object }
 *   'streams'  stream[]   — full list whenever it changes
 *
 * Usage:
 *   const sm = new StreamManager({ container, wsUrl });
 *   sm.on('sample', ({ value }) => ...);
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

  constructor({ container, wsUrl = "ws://localhost:8765" }) {
    this.#wsUrl = wsUrl;
    this.#buildUI(container);
    this.#connect();
  }

  // public event API

  on(event, cb) {
    (this.#handlers[event] ??= []).push(cb);
    return this;
  }

  // UI

  #buildUI(container) {
    container.innerHTML = `
      <span class="label">stream</span>
      <select id="stream-select">
        <option value="" disabled selected>no streams found</option>
      </select>
    `;
    this.#selectEl = container.querySelector("#stream-select");
    this.#selectEl.addEventListener("change", () => {
      const name = this.#selectEl.value;
      if (!name) return;
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

    if (sel.options.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.textContent = "no streams found";
      sel.appendChild(opt);
      sel.value = "";
      return;
    }

    if (this.#selectedStream) {
      sel.value = this.#selectedStream;
    } else if (this.#currentStreams.length > 0) {
      const first = this.#currentStreams[0].name;
      sel.value = first;
      this.#selectedStream = first;
      this.#send({ type: "select_stream", name: first });
    }
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
          this.#emit("sample", { value: msg.value, timestamp: msg.timestamp });
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
