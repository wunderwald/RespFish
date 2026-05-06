# stream — LSL Bridge and Marker Output

Two classes in [app/modules/stream/](./modules/stream/) connect the Electron frontend to the Python LSL bridge via WebSocket.

---

## StreamManager

Manages the WebSocket connection to the LSL bridge, renders a stream-selection dropdown, and emits typed events to the frontend.

```js
import { StreamManager } from './modules/stream/stream.js';

const sm = new StreamManager({
  container: document.querySelector('#stream-selector'),
  wsUrl:     'ws://localhost:8765',
  label:     'resp stream',
  filter:    'resp',              // auto-select first stream whose name contains this
});

sm.on('sample', ({ value, channels, timestamp }) => { /* called on every sample */ });
sm.on('status', ({ type, text, stream }) => {
  // type: 'connected' | 'disconnected' | 'searching'
});
sm.on('streams', (streams) => { /* full list whenever it changes */ });

sm.disable();  // lock the dropdown (call after calibration starts)
```

**Auto-selection**: if `filter` is set and no stream has been manually chosen, `StreamManager` automatically selects the first stream whose name contains the filter string (excluding marker streams). It will not override a user's explicit "— none —" selection.

**Reconnection**: the WebSocket reconnects automatically after a 3-second delay if the connection drops.

---

## MarkerStream

Sends string markers to a WebSocket endpoint for LSL forwarding. Non-blocking — markers are queued if the socket is not yet open.

```js
import { MarkerStream } from './modules/stream/markerStream.js';

const markers = new MarkerStream('ws://localhost:9001');
markers.send('trial_start_t0');
markers.send('trial_end_t0');
```

Reconnects automatically every 2 seconds if the connection is lost. Queued markers are flushed on reconnect.

---

## LSL bridge

The bridge ([lsl_bridge/README.md](../../lsl_bridge/README.md)) is a Python process that:

1. Discovers available LSL streams and broadcasts the list to connected clients.
2. Forwards samples from the selected stream as `{ type: 'sample', value, channels, timestamp }` JSON over WebSocket.
3. Accepts `{ type: 'select_stream', name }` messages from clients to switch streams.
4. Receives plain-text marker strings on a separate port and writes them to an LSL outlet (`RespFishMarkers`).

The bridge is started automatically by the Electron main process. To run it manually:

```bash
cd lsl_bridge && python main.py
```

See [lsl_bridge/README.md](../../lsl_bridge/README.md) for port assignments and configuration.
