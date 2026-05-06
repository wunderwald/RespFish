# visualizer — Live Signal Waveform Viewer

A diagnostic frontend for verifying the resp signal before starting an experiment. Shows a scrolling waveform trace and a fish that tracks the current breath level.

---

## Run

```bash
cd app && npm run visualizer
```

Or select **Visualizer** from the start screen (`npm start`).

---

## Signal input

Any LSL stream pushing normalised `[0, 1]` floats.

For testing, use:
```bash
cd resp && python simulate_lsl.py --bpm 14   # synthetic sine wave
cd resp && python mic_breath.py              # microphone
```

Select the stream in the experimenter window before the waveform will update.
