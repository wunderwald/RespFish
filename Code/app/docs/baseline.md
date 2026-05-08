# Baseline

Resting-state recording. The participant sees a neutral display with a countdown for 5 minutes while the resp signal is recorded and LSL markers are sent at the start and end.

---

## Run

```bash
cd app && npm run baseline
```

Or select **Baseline** from the start screen (`npm start`).

---

## Experimenter controls

| Control | What it does |
|---|---|
| **Resp stream** | Select the LSL resp stream. Required before pressing Start. |
| **Subject** | Subject code used as the CSV filename prefix. Locked once recording begins. |
| **Data dir** | Folder for CSV output. Click **…** to pick a different folder. Default: `baselineData/`. |
| **Start** | Begins the recording. Requires a connected resp stream. Sends the `baseline_start` marker. |
| **Abort** | Stops early and sends `baseline_abort`. Also triggered by `Escape`. |

---

## Session flow

```
stream ready → [Start] → 5-minute countdown → baseline_end marker → Done
```

The scene window shows a countdown timer.

---

## Data output

Two files are written to `output_data/baseline/` when the recording ends (normally or via Abort). Aborted sessions save whatever was recorded up to that point.

**`<SUBJECT_CODE>_baseline.csv`** — raw signal

| Column | Description |
|---|---|
| `timestamp` | ISO-8601 wall-clock time of the sample |
| `value` | Raw LSL sample value |

**`<SUBJECT_CODE>_baseline_estimates.csv`** — breath rate estimates

One row per method. Empty `hz`/`bpm` cells mean the estimator returned null (signal too short, or no clear periodicity found).

| Column | Description |
|---|---|
| `method` | Estimator name (`autocorr`, `peakTrough`, `welch`, `xcorr`) |
| `hz` | Estimated breathing rate in Hz |
| `bpm` | Estimated breathing rate in breaths per minute |

Sample rate for estimation is derived from the wall-clock timestamps in the raw CSV.

---

## LSL markers

Sent to the WebSocket marker bridge (`ws://localhost:9001` by default). Configure in `baseline_config.js`:

```js
SEND_MARKERS:      true,
MARKER_STREAM_URL: 'ws://localhost:9001',
```

| Marker | Event |
|---|---|
| `baseline_start` | Recording begins |
| `baseline_end` | 5 minutes elapsed — recording complete |
| `baseline_abort` | Experimenter pressed Abort |

---

## Adding a video

Replace the countdown canvas in `baseline.js` with a `<video>` element. The markers, state machine, and CSV recording stay the same — only the scene rendering changes.
