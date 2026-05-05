"""
LSL Gaze Simulator
==================
Pushes a synthetic 2-channel (x, y) gaze stream into an LSL outlet for
testing the iBreath gaze pipeline without an eye-tracker.

Movement model: independent bandlimited random walks for x and y.
Each axis maintains a slowly drifting velocity that is nudged by Gaussian
noise each step and soft-clamped when the position approaches the edges,
producing smooth, naturalistic scan-path trajectories in [0, 1].

Usage:
    python simulate_gaze.py [--rate HZ] [--name NAME]

Dependencies:
    pip install pylsl
"""

import argparse
import math
import random
import time

from pylsl import StreamInfo, StreamOutlet, cf_float32


# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULT_STREAM_NAME = "gaze_sim"
DEFAULT_SAMPLE_RATE = 60        # Hz

# ── Movement parameters ───────────────────────────────────────────────────────

VELOCITY_NOISE  = 0.008   # std-dev of per-step velocity perturbation
VELOCITY_DECAY  = 0.92    # exponential decay keeps velocity from diverging
MAX_VELOCITY    = 0.04    # hard cap per step (in normalised units)
EDGE_MARGIN     = 0.08    # soft-clamp zone near 0 and 1
EDGE_STRENGTH   = 0.6     # how strongly the edge pushes the velocity back


# ── Axis simulator ────────────────────────────────────────────────────────────

class GazeAxis:
    def __init__(self):
        self.pos = random.uniform(0.2, 0.8)
        self.vel = 0.0

    def step(self) -> float:
        self.vel *= VELOCITY_DECAY
        self.vel += random.gauss(0.0, VELOCITY_NOISE)
        self.vel = max(-MAX_VELOCITY, min(MAX_VELOCITY, self.vel))

        # Soft boundary repulsion
        if self.pos < EDGE_MARGIN:
            self.vel += EDGE_STRENGTH * (EDGE_MARGIN - self.pos) * MAX_VELOCITY
        elif self.pos > 1.0 - EDGE_MARGIN:
            self.vel -= EDGE_STRENGTH * (self.pos - (1.0 - EDGE_MARGIN)) * MAX_VELOCITY

        self.pos = max(0.0, min(1.0, self.pos + self.vel))
        return self.pos


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LSL gaze simulator (2-channel x/y)")
    p.add_argument("--rate", type=int, default=DEFAULT_SAMPLE_RATE,
                   help=f"Sample rate in Hz (default {DEFAULT_SAMPLE_RATE})")
    p.add_argument("--name", type=str, default=DEFAULT_STREAM_NAME,
                   help=f"LSL stream name (default '{DEFAULT_STREAM_NAME}')")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    info = StreamInfo(
        name=args.name,
        type="Gaze",
        channel_count=2,
        nominal_srate=args.rate,
        channel_format=cf_float32,
        source_id=f"{args.name}_sim",
    )
    outlet   = StreamOutlet(info)
    interval = 1.0 / args.rate

    x_axis = GazeAxis()
    y_axis = GazeAxis()

    print(f"[gaze_sim] Streaming '{args.name}' at {args.rate} Hz (2ch: x, y)")
    print("[gaze_sim] Press Ctrl+C to stop.\n")

    try:
        while True:
            loop_start = time.perf_counter()

            outlet.push_sample([x_axis.step(), y_axis.step()])

            elapsed = time.perf_counter() - loop_start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    except KeyboardInterrupt:
        print("\n[gaze_sim] Stopped.")
