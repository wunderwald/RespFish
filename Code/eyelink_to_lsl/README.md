# EyeLink → LSL Bridge

Connects an SR Research EyeLink eye tracker to LSL (Lab Streaming Layer). Gaze is published as normalised `[0.0, 1.0]` screen coordinates so any LSL consumer can work with it without knowing the display resolution.

---

## Requirements

| Package | Source |
|---|---|
| `pylink` | SR Research EyeLink Developer Kit — **not** the PyPI `pylink` package |
| `pylsl` | `pip install pylsl` |
| `psychopy` | `pip install psychopy` |
| `websockets` | `pip install websockets` — only needed to run `run_bridge.py`'s control API |

`pylink` ships as a compiled extension inside the EyeLink Developer Kit. Make sure its directory is on `PYTHONPATH` before importing.

> [!IMPORTANT]
> **PsychoPy needs its own virtual environment.** As of 2026, PsychoPy's PyPI metadata restricts it to `>=3.10, <3.13` — it will not install (or will misbehave) on a newer or older system Python. Don't install these requirements into your global/system Python or a shared project env. Instead, create a dedicated `.venv` inside `eyelink_to_lsl/` using Python 3.11.9, and always run the bridge (or any experiment script that imports it) through that venv.


---

## Hardware setup

```
PC 3 (EyeLink Host) ──Ethernet──► PC 1 (Experiment)
                                        ├─ Screen 1: Experimenter UI
                                        └─ Screen 2: Experiment display
                                                     (eye-tracking camera mounted here)
```

The default EyeLink link IP is `100.1.1.1`. Configure a static address on PC 1's tracking NIC to match (e.g. `100.1.1.2 / 255.255.255.0`).

---

## LSL stream

| Property | Value |
|---|---|
| Name | `GazeXY` |
| Type | `Gaze` |
| Channels | 2 — `x_norm`, `y_norm` |
| Format | `float32` |
| Rate | 500 Hz (nominal) |
| Missing / blink | `[-1.0, -1.0]` |

`x_norm` and `y_norm` are in `[0.0, 1.0]` where `(0, 0)` is the top-left corner of the experiment display.

---

## Quickstart

```python
from psychopy import visual
from eyelink_to_lsl import EyeLinkLSLBridge

# Open the experiment display on Screen 2
win = visual.Window(
    size=(1920, 1080),
    screen=1,           # 0-indexed; Screen 2 is index 1
    fullscr=True,
    units="pix",
)

bridge = EyeLinkLSLBridge(
    host_ip="100.1.1.1",
    screen_w=1920,
    screen_h=1080,
    window=win,         # used to draw calibration targets
    edf_filename="sub01",
)

bridge.connect()        # open tracker connection, register display
bridge.calibrate()      # show targets on Screen 2, operator confirms on PC 3
bridge.start()          # begin recording + LSL stream (non-blocking)

# --- run your experiment ---

bridge.stop()
bridge.disconnect()     # transfers EDF file to PC 1 and closes connection
```

---

## Recalibration mid-experiment

Call `request_calibrate()` from any thread — your WebSocket handler, a keypress callback, wherever:

```python
bridge.request_calibrate()
```

The pump thread will finish its current sample, stop recording, run a full calibration on Screen 2 (blocking until the operator accepts on PC 3), then resume recording automatically. The LSL stream continues; the gap during calibration will appear as missing samples (`-1.0, -1.0`).

---

## Running the bridge as a controllable process

`run_bridge.py` wraps `EyeLinkLSLBridge` in a long-running process with a JSON-over-WebSocket control API, so experimenter tooling — e.g. apps in [`../app/`](../app/) — can drive calibration and recording without embedding pylink/PsychoPy itself. This mirrors the `ws://` control convention already used by [`../lsl_ws_bridge/`](../lsl_ws_bridge/).

On Windows, start it via the venv wrapper:

```bat
start_bridge.bat --edf-filename sub01
```

Or directly:

```bash
.venv/bin/python run_bridge.py --edf-filename sub01
```

On startup it opens the PsychoPy window, connects to the EyeLink Host, runs an initial calibration, and starts recording — then serves the control WebSocket (default `ws://localhost:9002`) for the rest of the session. Defaults (host IP, screen size, ports, auto-calibrate/auto-start) live in `config.py`; see `--help` for the full list of overrides.

**Protocol** — client sends `{"type": "..."}`, server replies/broadcasts `{"type": "status", "state": ..., "recording": bool, ...}`:

| Command | Effect |
|---|---|
| `calibrate` | Recalibrate. Non-blocking (via `request_calibrate()`) if already recording; otherwise calibrates inline. |
| `start` | Start recording (no-op if already recording). |
| `stop` | Stop recording (no-op if not recording). |
| `status` | Request an immediate status snapshot. |
| `shutdown` | Stop recording, transfer the EDF file, disconnect the tracker, and exit. |

A status snapshot (`state` ∈ `connected`, `calibrating`, `calibrated`, `recording`, `stopped`, `disconnected`) is sent to every client on connect and broadcast to all connected clients whenever the bridge's lifecycle state changes — so a client doesn't need to poll to know when a recalibration it triggered has finished.

---

## Custom calibration display

If you are not using PsychoPy, implement the `CalibrationDisplay` protocol and pass it as `display`:

```python
class MyDisplay(pylink.EyeLinkCustomDisplay):
    def setup(self, tracker):
        tracker.openGraphicsEx(self)
    def teardown(self):
        pylink.closeGraphics()
    # implement draw_cal_target, clear_cal_display, get_input_key, ...

bridge = EyeLinkLSLBridge(
    host_ip="100.1.1.1",
    screen_w=1920,
    screen_h=1080,
    display=MyDisplay(),
)
```

`PsychopyCalibrationDisplay` draws a white filled circle with a black centre dot, forwards arrow/enter/escape key presses to the Host, and restores the background colour between targets. Adjust `TARGET_OUTER_RADIUS`, `TARGET_INNER_RADIUS`, `TARGET_COLOR_OUTER/INNER`, and `BG_COLOR` as class attributes if needed.

---

## EDF file

The EyeLink records a full-fidelity `.edf` file on PC 3 throughout the session. On `disconnect()`, the bridge transfers it to the working directory on PC 1 using `receiveDataFile()`. This file contains raw samples, events, and any messages sent via `tracker.sendMessage()` and serves as a ground-truth backup alongside your LSL recording.

---

## Key design notes

**Threading model.** The LSL pump runs in a background daemon thread. All pylink and display calls during recalibration are made from that same thread — this avoids the OpenGL context issues that arise when PsychoPy draw calls cross thread boundaries.

**`getNewestSample()` vs. event queue.** The pump uses `getNewestSample()` for simplicity. Under heavy CPU load this can drop frames. If you need every sample (e.g. for microsaccade analysis), replace the inner loop with the event-queue approach:

```python
dt = self._tracker.getNextData()
if dt == pylink.SAMPLE_TYPE:
    sample = self._tracker.getData()
```

**Binocular averaging.** When both eyes are tracked, `x_norm`/`y_norm` are the average of left and right gaze. If one eye is missing the valid eye is used. If you need per-eye channels, add four channels (`lx`, `ly`, `rx`, `ry`) and skip the averaging in `_extract_gaze`.
