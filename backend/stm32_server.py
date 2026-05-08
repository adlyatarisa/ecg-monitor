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
SAMPLE_RATE = 200          # Hz

COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800]

# ─── DSP Filters (designed once at startup) ──────────────────
_BANDPASS_SOS = butter(4, [0.5, 40.0], btype='band', fs=SAMPLE_RATE, output='sos')
_b, _a        = iirnotch(w0=50.0, Q=30.0, fs=SAMPLE_RATE)
_NOTCH_SOS    = tf2sos(_b, _a)

# ─── Runtime State ────────────────────────────────────────────
connected_ws: set          = set()
_serial_task               = None
_broadcast_task            = None
_bp_zi: np.ndarray | None  = None
_notch_zi: np.ndarray | None = None
CURRENT_PORT: str | None   = None
CURRENT_BAUD: int          = 115200
SERIAL_CONNECTED: bool     = False


# ─── DSP ─────────────────────────────────────────────────────
def apply_dsp(samples: list) -> list:
    global _bp_zi, _notch_zi
    arr = np.array(samples, dtype=np.float64)
    if _bp_zi is None:
        _bp_zi    = sosfilt_zi(_BANDPASS_SOS) * arr[0]
        _notch_zi = sosfilt_zi(_NOTCH_SOS)    * arr[0]
    out, _bp_zi    = sosfilt(_BANDPASS_SOS, arr, zi=_bp_zi)
    out, _notch_zi = sosfilt(_NOTCH_SOS,    out, zi=_notch_zi)
    return [round(float(v), 2) for v in out]


# ─── Serial Parsing ───────────────────────────────────────────
def parse_ecg_value(line: str):
    line = line.strip()
    if not line:
        return None
    if line.startswith('{'):
        try:
            obj = json.loads(line)
            val = obj.get('ecg') or obj.get('ECG') or obj.get('value')
            return int(val) if val is not None else None
        except Exception:
            pass
    m = re.match(r'^(?:ECG|ecg)\s*:\s*(-?\d+)', line, re.IGNORECASE)
    if m:
        return int(m.group(1))
    try:
        return int(line)
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
        print(f"[STM32] {port} opened.")
    except serial.SerialException as e:
        print(f"[STM32] FAILED to open {port}: {e}")
        SERIAL_CONNECTED = False
        return
    try:
        while True:
            raw = await loop.run_in_executor(None, ser.readline)
            if not raw:
                continue
            try:
                line = raw.decode('utf-8', errors='ignore')
            except Exception:
                continue
            val = parse_ecg_value(line)
            if val is not None:
                await queue.put(val)
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
    CHUNK = 10
    buf   = []
    try:
        while True:
            val = await queue.get()
            buf.append(val)
            if len(buf) >= CHUNK and connected_ws:
                filtered = apply_dsp(buf)
                payload  = json.dumps({"stm32_ecg": filtered, "stm32_ecg_raw": buf})
                dead = set()
                for ws in list(connected_ws):
                    try:
                        await ws.send_str(payload)
                    except Exception:
                        dead.add(ws)
                connected_ws -= dead
                buf = []
    except asyncio.CancelledError:
        pass


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
    global _serial_task, _broadcast_task, _bp_zi, _notch_zi
    global CURRENT_PORT, CURRENT_BAUD

    body = await request.json()
    port = body.get('port', '').strip()
    baud = int(body.get('baud', 115200))

    if not port:
        return web.json_response({'error': 'port is required'}, status=400)

    # Cancel previous serial/broadcast tasks
    for t in [_serial_task, _broadcast_task]:
        if t and not t.done():
            t.cancel()

    # Reset DSP state for new connection
    _bp_zi = _notch_zi = None
    CURRENT_PORT = port
    CURRENT_BAUD = baud

    q = asyncio.Queue(maxsize=2000)
    _serial_task    = asyncio.create_task(serial_reader(q, port, baud))
    _broadcast_task = asyncio.create_task(broadcast_worker(q))

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
    print(f"[DSP]  Band-pass [0.5–40 Hz] + Notch [50 Hz] @ {SAMPLE_RATE} Hz")
    print(f"[HTTP] GET  http://{SERVER_HOST}:{SERVER_PORT}/ports")
    print(f"[HTTP] POST http://{SERVER_HOST}:{SERVER_PORT}/connect")
    print(f"[HTTP] GET  http://{SERVER_HOST}:{SERVER_PORT}/status")
    print(f"[WS]   ws://{SERVER_HOST}:{SERVER_PORT}/ws")
    web.run_app(create_app(), host=SERVER_HOST, port=SERVER_PORT, print=None)
