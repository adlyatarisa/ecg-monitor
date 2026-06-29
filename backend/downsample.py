"""
Extract ECG channel 0 from raw data at its native 1000 Hz.

Source: ../data/s0221-06082208.dat (8-channel interleaved, 16-bit LE signed)
Output: ../data/ecg_0_1000hz.dat (single-channel, 16-bit LE signed)

No downsampling needed — the source file is already recorded at 1000 Hz,
which matches the STM32 hardware sampling rate.
"""

import struct
import os
import numpy as np

# --- Configuration ---
ORIGINAL_FS = 1000   # Hz — native recording rate of the source file
TARGET_FS   = 1000   # Hz — keep at native rate (matches STM32)
NUM_SIGNALS = 8      # channels interleaved in the source file

DATA_DIR    = os.path.join(os.path.dirname(__file__), '..', 'data')
INPUT_PATH  = os.path.join(DATA_DIR, 's0221-06082208.dat')
OUTPUT_PATH = os.path.join(DATA_DIR, 'ecg_0_1000hz.dat')

def main():
    with open(INPUT_PATH, 'rb') as f:
        raw = f.read()

    num_samples = len(raw) // (NUM_SIGNALS * 2)  # 2 bytes per int16
    print(f"[INFO] Original file: {len(raw)} bytes")
    print(f"[INFO] Original samples per channel: {num_samples}")
    print(f"[INFO] Original sampling rate: {ORIGINAL_FS} Hz")
    print(f"[INFO] Duration: {num_samples / ORIGINAL_FS:.2f} seconds")

    # Unpack all interleaved data (little-endian int16)
    all_data = struct.unpack(f'<{num_samples * NUM_SIGNALS}h', raw)

    # Extract ecg_0 (channel index 0, stride = NUM_SIGNALS)
    ecg_0 = np.array(all_data[0::NUM_SIGNALS], dtype=np.int16)
    print(f"[INFO] ecg_0 range: [{ecg_0.min()}, {ecg_0.max()}]")

    # No downsampling — already at target rate
    new_samples = len(ecg_0)
    print(f"\n[RESULT] Samples: {new_samples}")
    print(f"[RESULT] Sampling rate: {TARGET_FS} Hz")
    print(f"[RESULT] Duration: {new_samples / TARGET_FS:.2f} seconds")
    print(f"[RESULT] Output size: {new_samples * 2} bytes")

    # Save as single-channel int16 LE binary
    with open(OUTPUT_PATH, 'wb') as f:
        f.write(ecg_0.tobytes())

    print(f"\n[DONE] Saved to: {OUTPUT_PATH}")

if __name__ == '__main__':
    main()
