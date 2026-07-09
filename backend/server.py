import asyncio
import sys
import websockets
import struct
import json
import os
import numpy as np

# ProactorEventLoop (asyncio's Windows default) fires pending asyncio.sleep()
# timers almost instantly when interleaved with repeated websocket sends,
# which made the 1000 Hz chunk pacing below run at ~35x real speed.
# SelectorEventLoop doesn't have this issue.
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

DATA_DIR = os.path.join(os.path.dirname(__file__), '../data')
DATA_PATH = os.path.join(DATA_DIR, 'ecg_0_1000hz.dat')
SAMPLE_RATE = 1000  # Hz

# 24h reference ECG from a healthy subject (WFDB record 103003_ECG, 1000 Hz).
# Gain/baseline taken from 103003_ECG.hea: "1.2927(-9590)/uV" -> physical_uV = (raw - baseline) / gain
HEALTHY_ECG_PATH = os.path.join(DATA_DIR, '103003_ECG.dat')
HEALTHY_GAIN = 1.2927
HEALTHY_BASELINE = -9590

async def stream_data(websocket):
    print("Client connected!")
    if not os.path.exists(DATA_PATH):
        await websocket.send(json.dumps({"error": "Data not found"}))
        return

    with open(DATA_PATH, 'rb') as f:
        data = f.read()

    num_samples = len(data) // 2

    ecg_0 = struct.unpack(f'<{num_samples}h', data)

    # Memory-mapped so the 172MB file isn't fully loaded into RAM per client.
    healthy_ecg = None
    num_healthy = 0
    if os.path.exists(HEALTHY_ECG_PATH):
        healthy_ecg = np.memmap(HEALTHY_ECG_PATH, dtype='<i2', mode='r')
        num_healthy = len(healthy_ecg)
        print(f"[HEALTHY] Streaming 24h reference ECG: {num_healthy} samples @ {SAMPLE_RATE} Hz")
    else:
        print(f"[WARN] Healthy reference ECG not found: {HEALTHY_ECG_PATH}")

    chunk_size = 10
    delay = chunk_size / SAMPLE_RATE  # 0.01s @ 1000 Hz

    # Deadline-based pacing: track the absolute target time for each chunk
    # instead of sleeping a fixed amount every iteration. Windows' asyncio
    # timer granularity (~15.6ms) makes a plain `sleep(0.01)` overshoot on
    # every call, which compounds into a steady, cumulative slowdown. Sleeping
    # only until the next deadline lets short overshoots get absorbed instead
    # of stacking up.
    loop = asyncio.get_event_loop()
    start = loop.time()

    try:
        step = 0
        while True:
            i = (step * chunk_size) % num_samples
            raw_e = ecg_0[i:i+chunk_size]
            payload = {"ecg": list(raw_e)}

            if healthy_ecg is not None:
                j = (step * chunk_size) % num_healthy
                raw_h = healthy_ecg[j:j+chunk_size]
                physical_h = (raw_h.astype(np.float64) - HEALTHY_BASELINE) / HEALTHY_GAIN
                payload["healthy_ecg"] = [round(float(v), 2) for v in physical_h]

            await websocket.send(json.dumps(payload))

            step += 1
            next_time = start + step * delay
            now = loop.time()
            if next_time > now:
                await asyncio.sleep(next_time - now)
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected.")
    except Exception as e:
        print("Streaming Error:", e)

async def main():
    async with websockets.serve(stream_data, "0.0.0.0", 8080):
        print("WebSocket Server created: ws://0.0.0.0:8080")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())