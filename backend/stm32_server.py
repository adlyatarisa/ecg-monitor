import asyncio
import json
import re
import serial
import serial.tools.list_ports
import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, sosfilt_zi, tf2sos
from aiohttp import web

# ─── Server Config ────────────────────────────────────────────
SERVER_HOST = 'localhost'
SERVER_PORT = 8087
SAMPLE_RATE = 500          # Hz — must match TIM2 ISR rate on STM32

COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800]

# ─── DSP Filters (designed once at startup) ──────────────────
# ECG: bandpass 0.5–40 Hz (jantung listrik) + notch 50 Hz (PLN)
_ECG_BANDPASS_SOS = butter(4, [0.5, 40.0], btype='band', fs=SAMPLE_RATE, output='sos')
# PCG: bandpass 20–150 Hz (jantung akustik S1/S2) + notch 50 Hz
_PCG_BANDPASS_SOS = butter(4, [20.0, 150.0], btype='band', fs=SAMPLE_RATE, output='sos')
_b, _a            = iirnotch(w0=50.0, Q=30.0, fs=SAMPLE_RATE)
_NOTCH_SOS        = tf2sos(_b, _a)

# ─── Kalman Filter (1D, scalar) ───────────────────────────────
class KalmanFilter1D:
    """
    Simple 1D Kalman filter for real-time signal denoising.
    
    Model:
      x[k] = x[k-1] + w,   w ~ N(0, Q)   (process noise — how much signal can change per sample)
      z[k] = x[k]   + v,   v ~ N(0, R)   (measurement noise — sensor noise level)
    
    Tuning:
      - Higher Q → trusts measurement more → less smoothing, preserves fast transients (QRS peaks)
      - Higher R → trusts prediction more → more smoothing, may blunt sharp peaks
      - Ratio R/Q is what matters. For ECG: Q=0.05, R=1.0 works well.
    """
    def __init__(self, Q: float = 0.05, R: float = 1.0):
        self.Q = Q          # process noise covariance
        self.R = R          # measurement noise covariance
        self.x_hat = 0.0    # state estimate
        self.P = 1.0        # estimate covariance
        self._initialized = False

    def reset(self):
        self.x_hat = 0.0
        self.P = 1.0
        self._initialized = False

    def update(self, z: float) -> float:
        if not self._initialized:
            self.x_hat = z
            self.P = 1.0
            self._initialized = True
            return z
        # Predict
        x_pred = self.x_hat
        P_pred = self.P + self.Q
        # Update (Kalman gain)
        K = P_pred / (P_pred + self.R)
        self.x_hat = x_pred + K * (z - x_pred)
        self.P = (1 - K) * P_pred
        return self.x_hat

    def filter_array(self, arr: np.ndarray) -> np.ndarray:
        out = np.empty_like(arr)
        for i in range(len(arr)):
            out[i] = self.update(arr[i])
        return out


# ─── Runtime State ────────────────────────────────────────────
connected_ws: set          = set()
_serial_task               = None
_broadcast_task            = None
_data_queue: asyncio.Queue | None = None
_bp_zi_ecg: np.ndarray | None  = None
_notch_zi_ecg: np.ndarray | None = None
_bp_zi_pcg: np.ndarray | None  = None
_notch_zi_pcg: np.ndarray | None = None
# Kalman filter instances (persist across chunks for continuity)
_kalman_ecg: KalmanFilter1D | None = None
_kalman_pcg: KalmanFilter1D | None = None
CURRENT_PORT: str | None   = None
CURRENT_BAUD: int          = 115200
SERIAL_CONNECTED: bool     = False


# ─── DSP ─────────────────────────────────────────────────────
def apply_dsp(samples: list, is_pcg: bool = False) -> list:
    global _bp_zi_ecg, _notch_zi_ecg, _bp_zi_pcg, _notch_zi_pcg
    global _kalman_ecg, _kalman_pcg
    arr = np.array(samples, dtype=np.float64)
    if not is_pcg:
        if _bp_zi_ecg is None:
            _bp_zi_ecg    = sosfilt_zi(_ECG_BANDPASS_SOS) * arr[0]
            _notch_zi_ecg = sosfilt_zi(_NOTCH_SOS)        * arr[0]
            # ECG Kalman: Q=0.05 preserves QRS peaks, R=1.0 smooths baseline wander residual
            _kalman_ecg   = KalmanFilter1D(Q=0.05, R=1.0)
        out, _bp_zi_ecg    = sosfilt(_ECG_BANDPASS_SOS, arr,  zi=_bp_zi_ecg)
        out, _notch_zi_ecg = sosfilt(_NOTCH_SOS,        out,  zi=_notch_zi_ecg)
        out = _kalman_ecg.filter_array(out)
    else:
        if _bp_zi_pcg is None:
            _bp_zi_pcg    = sosfilt_zi(_PCG_BANDPASS_SOS) * arr[0]
            _notch_zi_pcg = sosfilt_zi(_NOTCH_SOS)        * arr[0]
            # PCG Kalman: Q=0.1 (PCG has faster transients S1/S2), R=0.8
            _kalman_pcg   = KalmanFilter1D(Q=0.1, R=0.8)
        out, _bp_zi_pcg    = sosfilt(_PCG_BANDPASS_SOS, arr,  zi=_bp_zi_pcg)
        out, _notch_zi_pcg = sosfilt(_NOTCH_SOS,        out,  zi=_notch_zi_pcg)
        out = _kalman_pcg.filter_array(out)
    return [round(float(v), 2) for v in out]


# ─── Serial Parsing ───────────────────────────────────────────
def parse_sensor_values(line: str):
    line = line.strip()
    if not line:
        return None
        
    # Check for "ecg,pcg" format
    if ',' in line:
        try:
            parts = line.split(',')
            return (int(parts[0].strip()), int(parts[1].strip()))
        except ValueError:
            pass

    if line.startswith('{'):
        try:
            obj = json.loads(line)
            ecg_val = obj.get('ecg') or obj.get('ECG') or obj.get('value')
            pcg_val = obj.get('pcg') or obj.get('PCG')
            if ecg_val is not None:
                return (int(ecg_val), int(pcg_val) if pcg_val is not None else 0)
            return None
        except Exception:
            pass
    m = re.match(r'^(?:ECG|ecg)\s*:\s*(-?\d+)', line, re.IGNORECASE)
    if m:
        return (int(m.group(1)), 0)
    try:
        return (int(line), 0)
    except ValueError:
        pass
    return None


# ─── Serial Reader Task ───────────────────────────────────────
async def serial_reader(queue: asyncio.Queue, port: str, baud: int):
    global SERIAL_CONNECTED
    loop = asyncio.get_event_loop()
    print(f"[STM32] Opening {port} @ {baud} baud...")
    try:
        ser = serial.Serial(port, baud, timeout=1)
        SERIAL_CONNECTED = True
        print(f"[STM32] {port} opened successfully.")
    except serial.SerialException as e:
        print(f"[STM32] FAILED to open {port}: {e}")
        SERIAL_CONNECTED = False
        return
    try:
        read_count = 0
        while True:
            raw = await loop.run_in_executor(None, ser.readline)
            if not raw:
                continue
            try:
                line = raw.decode('utf-8', errors='ignore')
            except Exception:
                continue
            
            if read_count < 5:
                print(f"[DEBUG] Raw line {read_count}: {repr(line)}")
            
            vals = parse_sensor_values(line)
            if vals is not None:
                read_count += 1
                if read_count % 20 == 0:
                    print(f"[STM32] Read {read_count} samples: ECG={vals[0]}, PCG={vals[1]}")
                await queue.put(vals)
    
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[STM32] Reader error: {e}")
    finally:
        SERIAL_CONNECTED = False
        ser.close()
        print(f"[STM32] {port} closed.")


# ─── Broadcast Task ───────────────────────────────────────────
async def broadcast_worker(queue: asyncio.Queue):
    global connected_ws
    CHUNK = 10
    buf_ecg = []
    buf_pcg = []
    chunk_count = 0
    print(f"[BROADCAST] Worker started, waiting for data...")
    try:
        while True:
            ecg_val, pcg_val = await queue.get()
            buf_ecg.append(ecg_val)
            buf_pcg.append(pcg_val)
            
            if len(buf_ecg) >= CHUNK:
                chunk_count += 1
                print(f"[BROADCAST] Chunk #{chunk_count}: {len(buf_ecg)} values, {len(connected_ws)} WS clients")
                
                try:
                    filtered_ecg = apply_dsp(buf_ecg, is_pcg=False)
                except Exception as e:
                    print(f"[DSP ECG Error] {e}")
                    filtered_ecg = buf_ecg

                try:
                    filtered_pcg = apply_dsp(buf_pcg, is_pcg=True)
                except Exception as e:
                    print(f"[DSP PCG Error] {e}")
                    filtered_pcg = buf_pcg

                import math
                filtered_ecg = [v if not math.isnan(v) else 0 for v in filtered_ecg]
                filtered_pcg = [v if not math.isnan(v) else 0 for v in filtered_pcg]

                try:
                    payload = json.dumps({
                        "timestamp": asyncio.get_event_loop().time(),
                        "stm32_ecg": filtered_ecg, 
                        "stm32_ecg_raw": buf_ecg,
                        "stm32_pcg": filtered_pcg,
                        "stm32_pcg_raw": buf_pcg
                    })
                except Exception as e:
                    print(f"[JSON Error] {e}")
                    payload = None

                if payload and connected_ws:
                    dead = set()
                    for ws in list(connected_ws):
                        try:
                            await ws.send_str(payload)
                        except Exception as e:
                            dead.add(ws)
                    if dead:
                        connected_ws -= dead
                
                buf_ecg = []
                buf_pcg = []
    except asyncio.CancelledError:
        print(f"[BROADCAST] Worker cancelled")
    except Exception as e:
        print(f"[BROADCAST] FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()


# ─── CORS Middleware ──────────────────────────────────────────
@web.middleware
async def cors_mw(request, handler):
    if request.method == 'OPTIONS':
        resp = web.Response(status=200)
    else:
        resp = await handler(request)
    resp.headers['Access-Control-Allow-Origin']  = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp


# ─── HTTP Routes ──────────────────────────────────────────────
async def route_ports(request):
    """GET /ports — list available COM ports + supported baud rates."""
    ports = [
        {'port': p.device, 'description': p.description or p.device}
        for p in sorted(serial.tools.list_ports.comports(), key=lambda x: x.device)
    ]
    return web.json_response({'ports': ports, 'bauds': COMMON_BAUDS})


async def route_connect(request):
    """POST /connect — start serial with selected port & baud."""
    global _serial_task, _broadcast_task, _bp_zi_ecg, _notch_zi_ecg, _bp_zi_pcg, _notch_zi_pcg
    global _kalman_ecg, _kalman_pcg
    global CURRENT_PORT, CURRENT_BAUD, _data_queue

    body = await request.json()
    port = body.get('port', '').strip()
    baud = int(body.get('baud', 115200))

    if not port:
        return web.json_response({'error': 'port is required'}, status=400)

    # Cancel previous serial/broadcast tasks
    for t in [_serial_task, _broadcast_task]:
        if t and not t.done():
            t.cancel()
            print(f"[CONNECT] Cancelled task: {t}")
            await asyncio.sleep(0.1)  # Give time for cancellation

    # Reset DSP state for new connection
    _bp_zi_ecg = _notch_zi_ecg = _bp_zi_pcg = _notch_zi_pcg = None
    _kalman_ecg = _kalman_pcg = None
    CURRENT_PORT = port
    CURRENT_BAUD = baud

    # Create GLOBAL queue that persists
    _data_queue = asyncio.Queue(maxsize=2000)
    print(f"[CONNECT] Creating serial_reader and broadcast_worker for {port} @ {baud}")
    _serial_task    = asyncio.create_task(serial_reader(_data_queue, port, baud))
    _broadcast_task = asyncio.create_task(broadcast_worker(_data_queue))
    print(f"[CONNECT] Tasks created: serial_task={_serial_task.get_name()}, broadcast_task={_broadcast_task.get_name()}")

    return web.json_response({'ok': True, 'port': port, 'baud': baud})


async def route_status(request):
    """GET /status — current connection status."""
    return web.json_response({
        'serial_connected': SERIAL_CONNECTED,
        'port':       CURRENT_PORT,
        'baud':       CURRENT_BAUD,
        'ws_clients': len(connected_ws),
    })


async def route_ws(request):
    """GET /ws — WebSocket for ECG data streaming."""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    connected_ws.add(ws)
    print(f"[WS] Client connected. Total: {len(connected_ws)}")
    async for _ in ws:
        pass  # clients are receive-only
    connected_ws.discard(ws)
    print(f"[WS] Client disconnected. Total: {len(connected_ws)}")
    return ws


# ─── App Factory ──────────────────────────────────────────────
def create_app():
    app = web.Application(middlewares=[cors_mw])
    app.router.add_get('/ports',   route_ports)
    app.router.add_post('/connect', route_connect)
    app.router.add_get('/status',  route_status)
    app.router.add_get('/ws',      route_ws)
    # OPTIONS preflight
    for path in ['/ports', '/connect', '/status']:
        app.router.add_route('OPTIONS', path, lambda r: web.Response(status=200))
    return app


if __name__ == '__main__':
    print(f"[DSP]  Band-pass ECG[0.5–40 Hz] PCG[20–150 Hz] + Notch [50 Hz] + Kalman @ {SAMPLE_RATE} Hz")
    print(f"[HTTP] GET  http://{SERVER_HOST}:{SERVER_PORT}/ports")
    print(f"[HTTP] POST http://{SERVER_HOST}:{SERVER_PORT}/connect")
    print(f"[HTTP] GET  http://{SERVER_HOST}:{SERVER_PORT}/status")
    print(f"[WS]   ws://{SERVER_HOST}:{SERVER_PORT}/ws")
    web.run_app(create_app(), host=SERVER_HOST, port=SERVER_PORT, print=None)
