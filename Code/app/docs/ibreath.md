# iBreath — Interoception Sync/Async Experiment

Port of the MATLAB version of iBreath (`ibreath_main_v2.m`) to Electron. On each trial the participant views an animation that either tracks their breath in real time (synchronous) or plays back a slightly speed-shifted version (asynchronous). There are multiple variations of the experiment (interoception task, exteroception task, gaze-tracked task...).

---

## Run

```bash
cd app && npm run ibreath
```

Two windows open:
- **Scene window** — shown on the participant's screen (fullscreen cloud animation)
- **Experimenter window** — your control panel

---

## Experimenter controls

| Control | What it does |
|---|---|
| **Subject** | Subject code written to the CSV filename. Locked once calibration begins. |
| **Group** | `intero` or `extero` — written to `trialData.csv` as the `group` column. |
| **Cal secs** | Calibration recording duration (default 10 s). |
| **Retry calibration** | Appears only if calibration fails (no signal received). Restarts the calibration recording. |
| **Use default calibration** | Appears only if calibration fails. Skips ahead using `CONFIG.DEFAULT_CAL_RANGE` instead of a measured range. |
| **Data dir** | Folder for CSV output. Default: `iBreathData/` inside the app folder. |
| **Auto-advance** | Skip the READY state between trials — experiment runs continuously. |
| **Show questions** | After each trial show a sync-detection question; record response in CSV. |
| **Flashing image** | Enable lightning flash stimulus on 50 % of trials. |
| **Animation display** | Show a 5-second pre-trial animation before each trial begins. |
| **Start** | Begins calibration. Requires a connected resp stream. |
| **Next trial** | Visible when `AUTO_ADVANCE` is off — advances to the next trial. |
| **Abort** | Ends the current trial early (marks it `aborted = true` in CSV). |

**Keyboard shortcuts** (scene or experimenter window focused):
- `Space` — advance from READY state
- `Escape` — abort current trial
- `←` — sync-detection response: yes (animation was in sync)
- `→` — sync-detection response: no (not in sync)

---

## Session flow

```
stream ready → [Start] → Calibration (10 s)
                               ↓
                   [READY — Space or Auto-advance]
                               ↓
                     [DISPLAY — 5 s animation]  (if ANIMATION_DISPLAY=true only)
                               ↓
                      Trial (up to 30 s)
                               ↓
                   [RESPONSE — ← or →]           (if SHOW_QUESTIONS only)
                               ↓
                      ITI (2–3 s jitter)
                               ↓
                   Repeat until 80 trials → Done
```

The state machine is: `IDLE → CALIBRATING → [READY] → [DISPLAY] → TRIAL → [RESPONSE] → ITI → … → DONE`

The `[READY]` step is skipped when `AUTO_ADVANCE` is on. The `[DISPLAY]` step is skipped when `ANIMATION_DISPLAY` is off. The `[RESPONSE]` step is skipped when `SHOW_QUESTIONS` is off or the trial was aborted.

---

## Trial design

- **80 trials** per session, balanced in blocks of 4: 2 sync, 1 async-slow, 1 async-fast.
- **Synchronous trials** — cloud animation tracks the Gaussian-smoothed breath signal, rescaled into `[0, 1]` using the calibration range (see [calibration](calibration.md)).
- **Asynchronous trials** — cloud follows a sine wave fitted to the participant's calibration breath, shifted in time (slow: ×1.1, fast: ×0.9 speed factor). Its output is separately rescaled to match the `[0, 1]`-space intensity actually observed during sync trials (`MAP_ASYNC_RANGE_TO_SYNC_RANGE`), so async and sync trials feel comparably intense.
- **Flash stimulus** (`FLASHING_IMAGE`) — a lightning image appears on 50 % of trials at a random time between `FLASH_TIME_MIN` and `FLASH_TIME_MAX` seconds into the trial.
- **Sync detection** (`SHOW_QUESTIONS`) — after each non-aborted trial, a question is shown for up to `RESPONSE_TIMEOUT_SECS` seconds. Non-responses are recorded as `timeout`.

---

## Configuration flags

Flags in [app/modules/ibreath/config.js](./modules/ibreath/config.js):

| Flag | Default | Effect |
|---|---|---|
| `AUTO_ADVANCE` | `true` | Skip READY state between trials |
| `SHOW_QUESTIONS` | `true` | Show sync-detection response screen after each trial |
| `FLASHING_IMAGE` | `true` | Enable lightning flash on 50 % of trials |
| `ANIMATION_DISPLAY` | `true` | Show 5-second pre-trial animation |
| `SEND_MARKERS` | `true` | Send LSL markers via WebSocket |
| `DEBUG_GAZE` | `false` | Overlay gaze position dot on scene |
| `MAX_NUM_TRIALS` | `80` | Total trial count |
| `MAX_TRIAL_TIME` | `30` | Trial auto-ends after this many seconds |
| `CALIBRATION_SECS` | `10` | Duration of the calibration recording |
| `MAP_ASYNC_RANGE_TO_SYNC_RANGE` | `true` | Rescale async trials' synthetic signal to the `[0, 1]`-space intensity actually observed during sync trials, so both feel comparably intense |

---

## Data output

Saved to `iBreathData/<SUBJECT_CODE>/` (or your chosen data dir).

### Trial data — `trialData.csv`

One row per trial, appended after each trial ends (or after the response screen if `SHOW_QUESTIONS` is on).

| Column | Description |
|---|---|
| `trialIndex` | 0-based trial number |
| `subject` | Subject code |
| `group` | `intero` or `extero` |
| `synchronous` | `true` / `false` |
| `img` | Cloud image variant used |
| `lr` | Cloud starting side (`left` / `right`) |
| `stimX0`, `stimY0` | Cloud start position (normalised 0–1) |
| `stimX1`, `stimY1` | Cloud end position (normalised 0–1) |
| `slowfast` | `slow`, `fast`, or empty (sync trials) |
| `ITI` | Inter-trial interval in ms |
| `startTime` | ISO-8601 trial start time |
| `endTime` | ISO-8601 trial end time |
| `aborted` | `true` if experimenter pressed Abort |
| `response` | `true` (yes), `false` (no), or `timeout` — only when `SHOW_QUESTIONS` is on |
| `flashImage` | Image name or empty — only when `FLASHING_IMAGE` is on |
| `flashScheduledTime` | Seconds into trial when flash was scheduled |
| `flashX`, `flashY` | Flash position (normalised 0–1) |
| `flashShown` | `true` if the flash actually fired before trial ended |

### Frame data — `frameData_<N>.csv`

One row per update tick (~16 ms) during trial N.

| Column | Description |
|---|---|
| `trialIndex` | Trial number |
| `timestamp` | ISO-8601 wall-clock time |
| `breathLevel_input` | Raw LSL sample |
| `breathLevel_scaled` | Same as input (scaling pipeline pass-through) |
| `stimulusLevel` | Stimulus level sent to renderer (0–1) |
| `flashActive` | `1` while flash is on screen — only when `FLASHING_IMAGE` is on |
| `gazeX`, `gazeY` | Gaze coordinates in pixels — only when gaze stream is connected |

---

## LSL markers

Sent to `MARKER_STREAM_URL` (default `ws://localhost:9001`).

| Marker | Event |
|---|---|
| `calibration_start` | Calibration begins (re-sent for each retry attempt) |
| `calibration_end` | Calibration recording window ends |
| `calibration_failed` | Calibration recorded no samples — experimenter is prompted to retry or use defaults |
| `calibration_default_used` | Experimenter chose to skip ahead using `CONFIG.DEFAULT_CAL_RANGE` after a failed calibration |
| `display_start_t<N>` | Pre-trial animation starts for trial N |
| `trial_start_t<N>` | Trial N begins |
| `trial_end_t<N>` | Trial N ends normally |
| `trial_abort_t<N>` | Trial N aborted by experimenter |
| `response_start_t<N>` | Response screen shown after trial N |
| `response_yes_t<N>` | Participant responded "yes, in sync" |
| `response_no_t<N>` | Participant responded "no, not in sync" |
| `response_timeout_t<N>` | Response timed out |
| `flash_start_t<N>` | Flash stimulus appears |
| `flash_end_t<N>` | Flash stimulus disappears |
| `iti_start_t<N>` | ITI begins after trial N |
| `experiment_done` | All trials complete |

---

## Signal input

Any LSL stream is supported — the raw signal doesn't need to already be normalised. It's rescaled into `[0, 1]` using the calibration-derived range (see [calibration](calibration.md)), the same way bioGame does.

For testing, use:

```bash
cd resp && python simulate_lsl.py --bpm 14   # synthetic sine wave
```

An optional second gaze stream is read from `GAZE_STREAM_URL` (`ws://localhost:8766` by default). Connect a stream that pushes `[gazeX, gazeY]` pixel coordinates. If no gaze stream is connected, gaze columns are omitted from the CSV.
