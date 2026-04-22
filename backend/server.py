import asyncio
import websockets
import struct
import json
import os

DATA_PATH = os.path.join(os.path.dirname(__file__), '../data/ecg_0_200hz.dat')

async def stream_data(websocket):
    print("Client connected!")
    if not os.path.exists(DATA_PATH):
        await websocket.send(json.dumps({"error": "Data not found"}))
        return

    # Read binary data
    with open(DATA_PATH, 'rb') as f:
        data = f.read()

    # Data is single-channel int16
    num_samples = len(data) // 2

    # Unpack all data (little endian short)
    ecg_0 = struct.unpack(f'<{num_samples}h', data)
    
    # 200Hz stream: 10 samples every 50ms
    chunk_size = 10 
    delay = 0.05   

    try:
        # Loop over the whole dataset continuously
        while True:
            for i in range(0, num_samples, chunk_size):
                # Slice raw points
                raw_e = ecg_0[i:i+chunk_size]

                payload = {
                    "ecg": list(raw_e)
                }
                
                await websocket.send(json.dumps(payload))
                await asyncio.sleep(delay)
            print("Finished full dataset loop. Restarting...")
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected.")
    except Exception as e:
        print("Streaming Error:", e)

async def main():
    async with websockets.serve(stream_data, "localhost", 8080):
        print("WebSocket Server created: ws://localhost:8080")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())

