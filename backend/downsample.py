"""
Downsample ECG data from 1000Hz to 200Hz.

Source: ../data/s0221-06082208.dat (8-channel interleaved, 16-bit LE signed)
Output: ../data/ecg_0_200hz.dat (single-channel, 16-bit LE signed)

Uses scipy.signal.decimate which applies an anti-aliasing (low-pass) filter
before downsampling to prevent aliasing artifacts.
"""

import struct
import os
import numpy as np
from scipy.signal import decimate

# --- Configuration ---
ORIGINAL_FS = 1000   
TARGET_FS = 200     
DOWNSAMPLE_FACTOR = ORIGINAL_FS // TARGET_FS  # = 5
NUM_SIGNALS = 8     

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
INPUT_PATH = os.path.join(DATA_DIR, 's0221-06082208.dat')
OUTPUT_PATH = os.path.join(DATA_DIR, 'ecg_0_200hz.dat')

def main():
    with open(INPUT_PATH, 'rb') as f:
        raw = f.read()

    num_samples = len(raw) // (NUM_SIGNALS * 2)  # 2 bytes per int16
    print(f"[INFO] Original file: {len(raw)} bytes")
    print(f"[INFO] Original samples per channel: {num_samples}")
    print(f"[INFO] Original sampling rate: {ORIGINAL_FS} Hz")
    print(f"[INFO] Duration: {num_samples / ORIGINAL_FS:.2f} seconds")

    # 2. Unpack all interleaved data (little-endian int16)
    all_data = struct.unpack(f'<{num_samples * NUM_SIGNALS}h', raw)

    # 3. Extract ecg_0 (channel index 0, stride = NUM_SIGNALS)
    ecg_0 = np.array(all_data[0::NUM_SIGNALS], dtype=np.float64)
    print(f"[INFO] ecg_0 range: [{ecg_0.min():.0f}, {ecg_0.max():.0f}]")

    # 4. Decimate: 1000Hz -> 200Hz (factor 5)
    #    decimate() applies an order-8 Chebyshev Type I lowpass filter by default
    ecg_200hz = decimate(ecg_0, DOWNSAMPLE_FACTOR)
    
    # Clip back to int16 range and convert
    ecg_200hz = np.clip(ecg_200hz, -32768, 32767).astype(np.int16)

    new_samples = len(ecg_200hz)
    print(f"\n[RESULT] Downsampled samples: {new_samples}")
    print(f"[RESULT] New sampling rate: {TARGET_FS} Hz")
    print(f"[RESULT] Duration: {new_samples / TARGET_FS:.2f} seconds")
    print(f"[RESULT] New range: [{ecg_200hz.min()}, {ecg_200hz.max()}]")
    print(f"[RESULT] Output size: {new_samples * 2} bytes")

    # 5. Save as single-channel int16 LE binary
    with open(OUTPUT_PATH, 'wb') as f:
        f.write(ecg_200hz.tobytes())

    print(f"\n[DONE] Saved to: {OUTPUT_PATH}")

if __name__ == '__main__':
    main()
