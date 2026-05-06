"""
Analog-to-LSL Bridge — Raspberry Pi 5 + ADS1115
================================================
Reads a single analog channel from an ADS1115 ADC over I2C and pushes the
normalised samples into an LSL outlet.

Hardware
--------
Wiring (ADS1115 ↔ Raspberry Pi 5 header):
    VDD  → 3.3 V  (pin 1)
    GND  → GND    (pin 6)
    SCL  → GPIO 3 (pin 5)
    SDA  → GPIO 2 (pin 3)
    ADDR → GND    (sets I2C address to 0x48, the default)

Signal input: connect sensor output to A0–A3 (default A0, --channel 0–3).
Connect sensor ground to GND.

Note on sample rate
-------------------
The ADS1115's maximum internal conversion rate is 860 SPS, giving 
headroom for 500 Hz. Pass --rate 860 to push to the hardware limit.

Dependencies
------------
    pip install pylsl adafruit-circuitpython-ads1x15

    I2C must be enabled on the Pi:
        sudo raspi-config  → Interface Options → I2C → Enable

Usage
-----
    python anlog_to_lsl.py [--channel N] [--rate HZ] [--name NAME] [--vdd V]
"""

import argparse
import time

import board
import busio
import adafruit_ads1x15.ads1115 as ADS
from adafruit_ads1x15.ads1x15 import Mode
from adafruit_ads1x15.analog_in import AnalogIn
from pylsl import StreamInfo, StreamOutlet, cf_float32


# ── Defaults ───────────────────────────────────────────────────────────────────

DEFAULT_STREAM_NAME = "resp_belt"
DEFAULT_SAMPLE_RATE = 500       # Hz
DEFAULT_CHANNEL     = 0         # ADS1115 channel A0–A3
DEFAULT_VDD         = 3.3       # V — supply voltage, used as normalisation ref

# ADS1115 internal conversion rate (set to max; throttled by our sleep loop)
ADS_DATA_RATE = 860

# Gain = 1 → full-scale ±4.096 V, which safely covers a 3.3 V sensor signal
ADS_GAIN = 1


# ── Argument parsing ───────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ADS1115-to-LSL bridge for Raspberry Pi")
    p.add_argument("--channel", type=int,   default=DEFAULT_CHANNEL,
                   help=f"ADS1115 input channel 0–3 (default {DEFAULT_CHANNEL})")
    p.add_argument("--rate",    type=int,   default=DEFAULT_SAMPLE_RATE,
                   help=f"Target sample rate in Hz (default {DEFAULT_SAMPLE_RATE}, max 860)")
    p.add_argument("--name",    type=str,   default=DEFAULT_STREAM_NAME,
                   help=f"LSL stream name (default '{DEFAULT_STREAM_NAME}')")
    p.add_argument("--vdd",     type=float, default=DEFAULT_VDD,
                   help=f"Supply voltage for normalisation (default {DEFAULT_VDD} V)")
    return p.parse_args()


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = parse_args()

    i2c = busio.I2C(board.SCL, board.SDA)
    ads = ADS.ADS1115(i2c)
    ads.data_rate = ADS_DATA_RATE   # internal conversion rate
    ads.mode      = Mode.CONTINUOUS  # no per-read conversion delay
    ads.gain      = ADS_GAIN

    channel_map = [ADS.P0, ADS.P1, ADS.P2, ADS.P3]
    channel = AnalogIn(ads, channel_map[args.channel])

    info = StreamInfo(
        name=args.name,
        type="Respiration",
        channel_count=1,
        nominal_srate=args.rate,
        channel_format=cf_float32,
        source_id=f"{args.name}_ads1115_ch{args.channel}",
    )
    outlet   = StreamOutlet(info)
    interval = 1.0 / args.rate

    print(f"[analog_to_lsl] ADS1115 channel=A{args.channel}  "
          f"VDD={args.vdd} V  internal rate={ADS_DATA_RATE} SPS")
    print(f"[analog_to_lsl] Streaming '{args.name}' at {args.rate} Hz")
    print("[analog_to_lsl] Press Ctrl+C to stop.\n")

    try:
        while True:
            loop_start = time.perf_counter()

            voltage = channel.voltage
            value   = max(0.0, min(1.0, voltage / args.vdd))  # normalise to [0, 1]
            outlet.push_sample([value])

            elapsed = time.perf_counter() - loop_start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    except KeyboardInterrupt:
        print("\n[analog_to_lsl] Stopped.")
