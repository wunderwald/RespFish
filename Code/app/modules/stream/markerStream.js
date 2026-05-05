// Sends string markers to a WebSocket endpoint for LSL forwarding.
// send() is non-blocking — WebSocket.send() writes to the OS network buffer
// immediately. Markers are queued if the socket is not yet open.

export class MarkerStream {
  #ws = null;
  #queue = [];
  #url;

  constructor(url) {
    this.#url = url;
    this.#open();
  }

  send(marker) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(marker);
    } else {
      this.#queue.push(marker);
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
      for (const m of this.#queue) this.#ws.send(m);
      this.#queue = [];
      console.log('[MarkerStream] connected');
    };
    this.#ws.onclose = () => setTimeout(() => this.#open(), 2000);
    this.#ws.onerror  = () => {};
  }
}
