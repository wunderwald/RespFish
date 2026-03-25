"""
Microphone → LSL Breath Signal
===============================
Captures the default macOS audio input, extracts a breath envelope,
normalises it to [0, 1] with a slow-adapting range, and pushes it into
LSL as a drop-in replacement for the resp belt.

Pipeline:
  mic → bandpass filter → RMS envelope → smoothing → dynamic normalisation → LSL

Usage:
  python mic_breath.py

Dependencies:
  pip install sounddevice numpy scipy pylsl
"""

import sys
import time
import threading
import numpy as np
import sounddevice as sd
from scipy.signal import butter, sosfilt, sosfilt_zi
from pylsl import StreamInfo, StreamOutlet, cf_float32

# #########
# CONSTANTS
# #########

STREAM_NAME = "resp_belt"     # LSL stream name (drop-in replacement)
LSL_RATE = 50              # Hz — output sample rate pushed to LSL

# --- bandpass filter (Hz) ---
BP_LOW = 60
BP_HIGH = 1000

# --- RMS envelope ---
RMS_WINDOW_MS = 50             # ms — RMS window length

# --- smoothing ---
SMOOTH_WINDOW = 3              # samples at LSL_RATE — rolling mean window

# --- input gain ---
INPUT_GAIN = 10.0

# --- normalisation ---
CALIBRATE = True            # if True: record 15s and derive range, then run
CALIB_SECS = 15              # calibration recording duration
FIXED_MIN = 0.0             # used when CALIBRATE = False
FIXED_MAX = 0.1             # used when CALIBRATE = False

# #########
# INTERNALS
# #########

AUDIO_RATE = 44100           # mic sample rate (fixed)
BP_ORDER = 4               # butterworth order


# ########
# PIPELINE
# ########

class BreathPipeline:
    """
    Stateful processing pipeline.  Call push_audio(block) from the
    sounddevice callback, then read .latest for the current output.
    """

    def __init__(self):
        # bandpass filter
        self.sos, self.zi = self._make_bandpass()

        # RMS envelope buffer
        self.rms_len = max(1, int(AUDIO_RATE * RMS_WINDOW_MS / 1000))
        self.rms_buf = np.zeros(self.rms_len)
        self.rms_idx = 0

        # smoothing buffer (at LSL_RATE)
        self.smooth_buf = np.zeros(SMOOTH_WINDOW)
        self.smooth_idx = 0

        # normalisation range (set after calibration or from constants)
        self.norm_min = FIXED_MIN
        self.norm_max = FIXED_MAX

        # accumulate audio samples between LSL output ticks
        self._accum = []
        self._accum_lock = threading.Lock()
        self.latest = 0.0

    def _make_bandpass(self):
        nyq = AUDIO_RATE / 2.0
        sos = butter(BP_ORDER,
                     [BP_LOW / nyq, BP_HIGH / nyq],
                     btype="band", output="sos")
        zi = sosfilt_zi(sos)[:, :, np.newaxis]  # shape for mono
        return sos, zi

    def push_audio(self, block: np.ndarray):
        """Called from sounddevice callback with a (N,1) float32 block."""
        block = block[:, 0] * INPUT_GAIN  # mono, apply gain

        # bandpass
        filtered, self.zi = sosfilt(self.sos, block,
                                    zi=self.zi.reshape(self.sos.shape[0], 2))
        self.zi = self.zi[:, :, np.newaxis]

        with self._accum_lock:
            self._accum.extend(filtered.tolist())

    def tick(self) -> float:
        """
        Called at LSL_RATE.  Drains the accumulator, computes RMS envelope,
        applies smoothing and normalisation, returns one output sample.
        """
        with self._accum_lock:
            samples = np.array(self._accum, dtype=np.float32)
            self._accum = []

        if len(samples) == 0:
            return self.latest

        # RMS envelope — fill circular buffer and compute mean RMS
        for s in samples:
            self.rms_buf[self.rms_idx] = s ** 2
            self.rms_idx = (self.rms_idx + 1) % self.rms_len
        rms = float(np.sqrt(np.mean(self.rms_buf)))

        # smoothing — rolling mean
        self.smooth_buf[self.smooth_idx] = rms
        self.smooth_idx = (self.smooth_idx + 1) % SMOOTH_WINDOW
        smoothed = float(np.mean(self.smooth_buf))

        r = self.norm_max - self.norm_min
        normalised = (smoothed - self.norm_min) / r if r > 1e-6 else 0.0
        normalised = float(np.clip(normalised, 0.0, 1.0))

        self.latest = normalised
        return normalised


# ####
# MAIN
# ####

if __name__ == "__main__":
    pipeline = BreathPipeline()

    # LSL outlet
    info = StreamInfo(STREAM_NAME, "Respiration", 1,
                      LSL_RATE, cf_float32, f"{STREAM_NAME}_mic")
    outlet = StreamOutlet(info)

    # sounddevice callback — runs in audio thread
    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"\n[audio] {status}", file=sys.stderr)
        pipeline.push_audio(indata)

    interval = 1.0 / LSL_RATE
    pushed = 0
    t_start = time.perf_counter()

    print(f"[mic_breath] bandpass {BP_LOW}–{BP_HIGH} Hz  |  "
          f"rms {RMS_WINDOW_MS} ms  |  smooth {SMOOTH_WINDOW} smp  |  "
          f"gain {INPUT_GAIN}")
    print("[mic_breath] Press Ctrl+C to stop.\n")

    with sd.InputStream(samplerate=AUDIO_RATE, channels=1,
                        dtype="float32", callback=audio_callback):
        try:
            # ── calibration ──────────────────────────────────────────────
            if CALIBRATE:
                print(
                    f"[mic_breath] calibrating for {CALIB_SECS}s — breathe normally …")
                calib_samples = []
                calib_ticks = CALIB_SECS * LSL_RATE

                for i in range(calib_ticks):
                    next_tick = t_start + (pushed + 1) * interval
                    while time.perf_counter() < next_tick:
                        time.sleep(0.0005)
                    raw = pipeline.tick()
                    calib_samples.append(raw)
                    pushed += 1
                    remaining = CALIB_SECS - i // LSL_RATE
                    print(
                        f"\r[mic_breath] calibrating … {remaining}s ", end="", flush=True)

                calib_min = float(np.min(calib_samples))
                calib_max = float(np.max(calib_samples))
                pipeline.norm_min = calib_min
                pipeline.norm_max = calib_max

                print(f"\n[mic_breath] calibration done.")
                print(f"[mic_breath]   FIXED_MIN = {calib_min:.6f}")
                print(f"[mic_breath]   FIXED_MAX = {calib_max:.6f}")
                print(
                    f"[mic_breath] Set these as defaults and use CALIBRATE = False.\n")
            else:
                print(
                    f"[mic_breath] using fixed range [{FIXED_MIN:.6f} – {FIXED_MAX:.6f}]")

            # ── streaming ────────────────────────────────────────────────
            print(f"[mic_breath] streaming '{STREAM_NAME}' at {LSL_RATE} Hz …")
            while True:
                next_tick = t_start + (pushed + 1) * interval
                while time.perf_counter() < next_tick:
                    time.sleep(0.0005)

                value = pipeline.tick()
                outlet.push_sample([value])
                pushed += 1

        except KeyboardInterrupt:
            print("\n[mic_breath] Stopped.")
