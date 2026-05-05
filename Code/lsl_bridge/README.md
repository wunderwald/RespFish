# lsl_bridge

Python bridge between LSL and the RespFish Electron app. Started automatically by the app.

```
LSL stream  →  signal_bridge  →  WebSocket :8765  →  app (breath signal)
LSL stream  →  signal_bridge  →  WebSocket :8766  →  app (gaze signal)
app         →  WebSocket :9001  →  marker_bridge  →  LSL outlet
```

## Run manually

```bash
cd lsl_bridge
python main.py
```

Requires the `.venv` from the repo root: `pip install pylsl websockets`.

## Ports

| Port | Direction | Protocol | Purpose |
|------|-----------|----------|---------|
| 8765 | bridge → app | JSON over WebSocket | breath signal samples + stream list |
| 8766 | bridge → app | JSON over WebSocket | gaze signal samples + stream list |
| 9001 | app → bridge | plain text WebSocket | experiment markers → LSL |

## Modules

| File | Contents |
|------|----------|
| `config.py` | ports, timing constants, log settings |
| `signal_bridge.py` | LSL stream discovery, sample forwarding, WebSocket handler |
| `marker_bridge.py` | receives marker strings, pushes to LSL outlet `RespFishMarkers` |
| `main.py` | wires everything together, entry point |

## Config

All tunables are in `config.py`:
