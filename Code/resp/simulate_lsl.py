"""
LSL Stream Simulator — Physiological Breath Model
===================================================
Pushes a synthetic respiration signal into an LSL outlet for testing the
bridge and frontend without physical hardware.

Improvements over the original simulate_lsl.py
-----------------------------------------------
* Realistic waveform shape:
    - Asymmetric inhale/exhale (configurable ratio, default 40/60 %).
    - Smooth cubic interpolation between the four breath landmarks
      (onset, peak, return, trough) rather than a simple half-sine.
* Biological variability:
    - Slow drift in instantaneous rate (±15 % of BPM) modelled as a
      low-pass-filtered random walk.  Mimics the natural cycle-to-cycle
      variation seen in respiration belt recordings.
    - Per-cycle amplitude jitter (±12 %) so successive breaths are not
      identical.
    - Occasional deep breaths (~8 % of cycles, ~1.4× normal amplitude).
* Additive measurement noise:
    - Low-amplitude Gaussian noise (σ = 0.008) matching typical belt
      sensor noise floors.
    - Slow baseline wander (0.05 Hz sinusoid, amplitude 0.03) matching
      movement artefact.
* Output range:
    - Normalised to [0.0, 1.0] matching the bridge's expected format.

Usage:
    python simulate_lsl.py [--bpm BPM] [--rate HZ] [--name NAME]

Dependencies:
    pip install pylsl
"""

import argparse
import math
import random
import time

from pylsl import StreamInfo, StreamOutlet, cf_float32


# ── Default configuration ─────────────────────────────────────────────────────

DEFAULT_STREAM_NAME = "resp_belt_sim"
DEFAULT_SAMPLE_RATE = 500       # Hz  — matches original
DEFAULT_BPM         = 12.0      # breaths per minute at rest


# ── Physiological parameters ──────────────────────────────────────────────────

INHALE_FRACTION   = 0.40   # fraction of breath cycle spent inhaling
EXHALE_FRACTION   = 0.60   # fraction of breath cycle spent exhaling

# Rate variability: BPM drifts by up to ±RATE_VARIABILITY_FRAC of the base BPM
# modelled as a first-order AR(1) process updated once per cycle.
RATE_VARIABILITY_FRAC = 0.15
RATE_SMOOTHING        = 0.25   # how quickly the rate change takes effect [0,1]

# Amplitude variability
AMP_JITTER_FRAC       = 0.12   # ± fraction of nominal amplitude per cycle
DEEP_BREATH_PROB      = 0.08   # probability of a deep breath per cycle
DEEP_BREATH_FACTOR    = 1.40   # amplitude multiplier for deep breaths

# Additive noise
NOISE_SIGMA           = 0.008  # Gaussian noise standard deviation
WANDER_FREQ           = 0.05   # Hz of slow baseline wander sinusoid
WANDER_AMP            = 0.03   # amplitude of baseline wander


# ── Waveform generator ────────────────────────────────────────────────────────

def cubic_ease(t: float) -> float:
    """Smooth cubic S-curve mapping t ∈ [0,1] → [0,1].
    Produces a more physiologically realistic acceleration/deceleration than
    a half-sine, with zero velocity at both endpoints."""
    return t * t * (3.0 - 2.0 * t)


def breath_sample(phase: float, amp: float) -> float:
    """
    Generate a single breath sample from a normalised cycle phase ∈ [0, 1).

    The waveform has four landmarks:
      0.0                 — start of inhale (trough)
      INHALE_FRACTION     — peak of inhale
      INHALE_FRACTION+ε   — start of exhale (brief hold, not modelled)
      1.0                 — end of exhale (trough again)

    Each segment is a cubic ease-in/ease-out curve so transitions are smooth.
    """
    if phase < INHALE_FRACTION:
        # Inhale: 0 → amp
        t = phase / INHALE_FRACTION
        return amp * cubic_ease(t)
    else:
        # Exhale: amp → 0
        t = (phase - INHALE_FRACTION) / EXHALE_FRACTION
        return amp * (1.0 - cubic_ease(t))


# ── Per-cycle state ───────────────────────────────────────────────────────────

class BreathState:
    """Tracks slowly-varying biological parameters across breath cycles."""

    def __init__(self, base_bpm: float):
        self.base_bpm     = base_bpm
        self.current_bpm  = base_bpm
        self.current_amp  = 1.0     # nominal; jitter applied per cycle
        self._bpm_target  = base_bpm

    def next_cycle(self) -> tuple[float, float]:
        """
        Advance to the next breath cycle.
        Returns (period_seconds, amplitude_fraction).
        """
        # BPM random walk: pick a new target, smooth toward it
        noise          = random.gauss(0, self.base_bpm * RATE_VARIABILITY_FRAC)
        self._bpm_target = self.base_bpm + noise
        self._bpm_target = max(self.base_bpm * 0.5,
                               min(self.base_bpm * 1.5, self._bpm_target))
        self.current_bpm += RATE_SMOOTHING * (self._bpm_target - self.current_bpm)

        # Amplitude jitter
        jitter = random.uniform(-AMP_JITTER_FRAC, AMP_JITTER_FRAC)
        amp    = 1.0 + jitter

        # Occasional deep breath
        if random.random() < DEEP_BREATH_PROB:
            amp *= DEEP_BREATH_FACTOR

        self.current_amp = max(0.3, amp)   # never fully flat
        period = 60.0 / self.current_bpm
        return period, self.current_amp


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Physiological LSL breath simulator")
    p.add_argument("--bpm",  type=float, default=DEFAULT_BPM,
                   help=f"Base breathing rate in BPM (default {DEFAULT_BPM})")
    p.add_argument("--rate", type=int,   default=DEFAULT_SAMPLE_RATE,
                   help=f"Sample rate in Hz (default {DEFAULT_SAMPLE_RATE})")
    p.add_argument("--name", type=str,   default=DEFAULT_STREAM_NAME,
                   help=f"LSL stream name (default '{DEFAULT_STREAM_NAME}')")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    info = StreamInfo(
        name=args.name,
        type="Respiration",
        channel_count=1,
        nominal_srate=args.rate,
        channel_format=cf_float32,
        source_id=f"{args.name}_sim",
    )
    outlet   = StreamOutlet(info)
    interval = 1.0 / args.rate

    state = BreathState(base_bpm=args.bpm)

    print(f"[simulator] Streaming '{args.name}' at {args.rate} Hz, "
          f"base BPM={args.bpm}")
    print("[simulator] Press Ctrl+C to stop.\n")

    t_abs    = 0.0    # absolute time (seconds)
    t_cycle  = 0.0    # time within current cycle
    period, amp = state.next_cycle()

    try:
        while True:
            loop_start = time.perf_counter()

            # Normalised phase within current cycle
            phase = t_cycle / period

            # Core breath waveform
            value = breath_sample(phase, amp)

            # Baseline wander
            wander = WANDER_AMP * math.sin(2 * math.pi * WANDER_FREQ * t_abs)

            # Gaussian measurement noise
            noise = random.gauss(0.0, NOISE_SIGMA)

            # Composite signal, clamped to [0, 1]
            sample = max(0.0, min(1.0, value + wander + noise))

            outlet.push_sample([sample])

            # Advance time
            t_abs   += interval
            t_cycle += interval

            # New cycle when current one ends
            if t_cycle >= period:
                t_cycle -= period
                period, amp = state.next_cycle()

            # Busy-wait for precise timing (matches original approach)
            elapsed = time.perf_counter() - loop_start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    except KeyboardInterrupt:
        print("\n[simulator] Stopped.")