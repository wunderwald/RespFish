# Baseline

A simple resting-state recording. The participant sees a neutral display for 5 minutes while LSL markers are sent at the start and end. No breath signal required.

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
| **Start** | Begins the 5-minute recording and sends the `baseline_start` marker. |
| **Abort** | Stops early and sends `baseline_abort`. Also triggered by `Escape`. |

There are no stream selectors, baseline requires no LSL input.

---

## Session flow

```
[Start] → 5-minute countdown → baseline_end marker → Done
```

The scene window shows a countdown timer. When a video is added, it will replace the countdown.

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

## Adding the video

Replace the countdown in `baseline.js` with a `<video>` element. The markers and state machine stay the same — only the scene rendering changes.
