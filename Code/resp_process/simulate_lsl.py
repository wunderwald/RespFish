"""
LSL Stream Simulator
====================
Pushes a synthetic respiration signal into LSL for testing the bridge
without physical hardware.

Waveform: asymmetric sine (faster inhale, slower exhale) + small noise.

Usage:
  python simulate_lsl.py

Dependencies:
  pip install pylsl
"""

import math
import random
import time

from pylsl import StreamInfo, StreamOutlet, cf_float32

# #########
# CONSTANTS
# #########

STREAM_NAME = "resp_belt"   # must match STREAM_NAME in bridge.py
SAMPLE_RATE = 100           # Hz
BPM         = 15.0          # simulated breathing rate


# #######
# HELPERS
# #######

def breath_sample(t, bpm):
    """Asymmetric sine: 40% inhale, 60% exhale, with small noise."""
    period = 60.0 / bpm
    phase  = (t % period) / period

    if phase < 0.4:
        value = math.sin(math.pi * phase / 0.4)
    else:
        value = math.sin(math.pi * (1.0 - (phase - 0.4) / 0.6))

    return value + random.gauss(0, 0.02)


# ####
# MAIN
# ####

if __name__ == "__main__":
    info = StreamInfo(
        name=STREAM_NAME,
        type="Respiration",
        channel_count=1,
        nominal_srate=SAMPLE_RATE,
        channel_format=cf_float32,
        source_id=f"{STREAM_NAME}_sim",
    )

    outlet   = StreamOutlet(info)
    interval = 1.0 / SAMPLE_RATE
    t        = 0.0

    print(f"[simulator] Streaming '{STREAM_NAME}' at {SAMPLE_RATE} Hz, {BPM} BPM")
    print("[simulator] Press Ctrl+C to stop.\n")

    try:
        while True:
            start = time.perf_counter()
            outlet.push_sample([breath_sample(t, BPM)])
            t      += interval
            elapsed = time.perf_counter() - start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)
    except KeyboardInterrupt:
        print("\n[simulator] Stopped.")
