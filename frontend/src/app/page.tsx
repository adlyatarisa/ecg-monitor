'use client';

import { useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  type ChartOptions
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { 
  Activity, Wifi, WifiOff, RefreshCw, Plug, 
  ChevronDown, Loader2, AlertCircle, HeartPulse, Stethoscope 
} from 'lucide-react';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler
);

// ─── Constants & Utils ────────────────────────────────────────────────────────
const MAX_POINTS = 500;
const labels = Array.from({ length: MAX_POINTS }, (_, i) => i);
const BACKEND = 'http://localhost:8087';
const WS_URL_STM32 = 'ws://localhost:8087/ws';
const WS_URL_HISTORICAL = 'ws://localhost:8080';
const COMMON_BAUDS = [9600, 38400, 115200, 230400];

// EMA Smoothing helper
function applyEMA(buf: (number | null)[], alpha: number): (number | null)[] {
  const out: (number | null)[] = new Array(buf.length);
  let prev: number | null = null;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v === null) { out[i] = null; prev = null; }
    else { prev = prev === null ? v : alpha * v + (1 - alpha) * prev; out[i] = prev; }
  }
  return out;
}

const pinkChartOptions: ChartOptions<'line'> = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  elements: {
    point: { radius: 0 },
    line: { borderWidth: 1.5, tension: 0.1 }
  },
  scales: {
    x: { display: true, grid: { color: '#fce7f3', lineWidth: 0.4 }, ticks: { display: false } },
    y: {
      display: true,
      min: -2500,
      max: 2500,
      grid: { color: '#fce7f3', lineWidth: 0.4 },
      ticks: { color: '#f9a8d4', font: { size: 10, weight: 600 } }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } }
};

// ─── Reusable Components ──────────────────────────────────────────────────────
const ChartCard = ({ title, subtitle, live = false, data, waiting = false, className = '' }: any) => (
  <div className={`bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl px-5 pt-5 pb-4 flex flex-col relative ${className}`}>
    <div className="flex justify-between items-start mb-3">
      <div>
        <h3 className="text-[13px] font-bold text-[#831843] m-0 uppercase tracking-wider">{title}</h3>
        <p className="text-[10px] font-semibold text-[#ec4899] mt-[3px]">{subtitle}</p>
      </div>
      {live && (
        <div className="flex items-center gap-[5px] text-[10px] font-bold text-[#db2777] tracking-[0.1em]">
          <div className="w-[7px] h-[7px] rounded-full bg-[#db2777] animate-pulse" />
          LIVE
        </div>
      )}
    </div>
    <div className="flex-1 relative w-full min-h-0">
      {waiting ? (
        <div className="absolute inset-0 flex flex-center justify-center items-center">
          <span className="text-[12px] font-semibold text-[#f9a8d4]">Waiting for stream...</span>
        </div>
      ) : (
        <Line
          data={{
            labels,
            datasets: [{
              data,
              borderColor: '#db2777',
              borderWidth: 1.8,
              tension: 0.4,
              pointRadius: 0,
            }]
          }}
          options={pinkChartOptions}
        />
      )}
    </div>
  </div>
);

// ─── Main Dashboard Component ─────────────────────────────────────────────────
export default function Dashboard() {
  // Setup States
  const [setupDone, setSetupDone] = useState(false);
  const [ports, setPorts] = useState<{port: string, description: string}[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [selectedBaud, setSelectedBaud] = useState(115200);
  const [portsLoading, setPortsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Data States
  const [connectedHistorical, setConnectedHistorical] = useState(false);
  const [connectedSTM32, setConnectedSTM32] = useState(false);
  const [historicalBuffer, setHistoricalBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [stm32Buffer, setStm32Buffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [pcgBuffer, setPcgBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));

  // 1. Fetch Ports
  const fetchPorts = async () => {
    setPortsLoading(true);
    setConnectError('');
    try {
      const res = await fetch(`${BACKEND}/ports`);
      const data = await res.json();
      setPorts(data.ports ?? []);
      if (data.ports?.length === 1) setSelectedPort(data.ports[0].port);
    } catch {
      setConnectError('Backend error. Check stm32_server.py.');
    } finally {
      setPortsLoading(false);
    }
  };

  useEffect(() => { fetchPorts(); }, []);

  // 2. Connect Device
  const connectDevice = async () => {
    if (!selectedPort) return;
    setConnecting(true);
    try {
      const res = await fetch(`${BACKEND}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baud: selectedBaud }),
      });
      const data = await res.json();
      if (data.ok) setSetupDone(true);
      else setConnectError(data.error ?? 'Connection failed.');
    } catch {
      setConnectError('Network error.');
    } finally {
      setConnecting(false);
    }
  };

  // 3. WebSockets (Only after setup)
  useEffect(() => {
    if (!setupDone) return;

    // Historical Socket
    const wsH = new WebSocket(WS_URL_HISTORICAL);
    let hBuf = Array(MAX_POINTS).fill(null);
    let hIdx = 0;
    wsH.onopen = () => setConnectedHistorical(true);
    wsH.onmessage = (e) => {
      const payload = JSON.parse(e.data);
      if (payload.ecg) {
        payload.ecg.forEach((val: number) => {
          hBuf[hIdx] = val;
          hIdx = (hIdx + 1) % MAX_POINTS;
        });
        setHistoricalBuffer([...hBuf]);
      }
    };

    // STM32 Live Socket
    const wsS = new WebSocket(WS_URL_STM32);
    let sBuf = Array(MAX_POINTS).fill(null);
    let pBuf = Array(MAX_POINTS).fill(null);
    let sIdx = 0;
    let pIdx = 0;
    wsS.onopen = () => {
      console.log("[WS] STM32 socket opened");
      setConnectedSTM32(true);
    };
    wsS.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.timestamp) {
          console.log(`[WS] Got chunk, timestamp: ${payload.timestamp.toFixed(2)}, ECG[0]: ${payload.stm32_ecg?.[0] || 'none'}`);
        }
        
        const ecgData = payload.stm32_ecg_raw || payload.stm32_ecg;
        const pcgData = payload.stm32_pcg_raw || payload.stm32_pcg;

        if (ecgData && Array.isArray(ecgData)) {
          ecgData.forEach((val: number) => {
            sBuf[sIdx] = val;
            for (let g = 1; g <= 10; g++) sBuf[(sIdx + g) % MAX_POINTS] = null;
            sIdx = (sIdx + 1) % MAX_POINTS;
          });
          setStm32Buffer([...applyEMA(sBuf, 0.25)]);
        }
        if (pcgData && Array.isArray(pcgData)) {
          pcgData.forEach((val: number) => {
            pBuf[pIdx] = val;
            for (let g = 1; g <= 10; g++) pBuf[(pIdx + g) % MAX_POINTS] = null;
            pIdx = (pIdx + 1) % MAX_POINTS;
          });
          setPcgBuffer([...applyEMA(pBuf, 0.25)]);
        }
      } catch (err) {
        console.error("[WS] Parse error:", err);
      }
    };
    wsS.onclose = () => {
      console.log("[WS] STM32 socket closed");
      setConnectedSTM32(false);
    };
    wsS.onerror = (err) => {
      console.error("[WS] STM32 socket error:", err);
    };

    return () => { wsH.close(); wsS.close(); };
  }, [setupDone]);

  // ─── UI: SETUP SCREEN (PINK THEME) ──────────────────────────
  if (!setupDone) {
    return (
      <div className="min-h-screen bg-[#fff5f8] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-xl border border-[#fbcfe8] w-full max-w-md overflow-hidden">
          <div className="bg-gradient-to-r from-[#db2777] to-[#ec4899] px-8 py-8 text-white">
            <div className="flex items-center gap-3 mb-2">
              <Activity size={24} />
              <h1 className="text-xl font-bold tracking-tight">System Configuration</h1>
            </div>
            <p className="text-pink-100 text-[11px] opacity-90">Select hardware port to begin monitoring</p>
          </div>

          <div className="p-8 space-y-6">
            <div>
              <label className="block text-[10px] font-bold text-[#831843] uppercase tracking-widest mb-3">Serial Port</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select 
                    value={selectedPort} 
                    onChange={e => setSelectedPort(e.target.value)}
                    className="w-full appearance-none pl-4 pr-10 py-3 border border-[#fbcfe8] rounded-xl text-sm text-[#831843] bg-[#fff0f5] focus:ring-2 focus:ring-[#f472b6] outline-none transition-all"
                  >
                    <option value="">Choose Port...</option>
                    {ports.map(p => <option key={p.port} value={p.port}>{p.port}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#ec4899]" />
                </div>
                <button onClick={fetchPorts} className="p-3 border border-[#fbcfe8] rounded-xl text-[#ec4899] hover:bg-[#fce7f3] transition-all">
                  {portsLoading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#831843] uppercase tracking-widest mb-3">Baud Rate</label>
              <div className="grid grid-cols-4 gap-2">
                {COMMON_BAUDS.map(b => (
                  <button 
                    key={b} 
                    onClick={() => setSelectedBaud(b)}
                    className={`py-2 rounded-lg text-[10px] font-bold border transition-all ${selectedBaud === b ? 'bg-[#db2777] border-[#db2777] text-white' : 'bg-white border-[#fbcfe8] text-[#ec4899] hover:bg-[#fff0f5]'}`}
                  >
                    {b >= 1000 ? `${b/1000}K` : b}
                  </button>
                ))}
              </div>
            </div>

            {connectError && (
              <div className="bg-red-50 border border-red-100 text-red-500 text-[11px] p-3 rounded-xl flex items-center gap-2">
                <AlertCircle size={14} /> {connectError}
              </div>
            )}

            <button 
              onClick={connectDevice} 
              disabled={connecting || !selectedPort}
              className="w-full py-4 rounded-2xl text-sm font-bold text-white bg-gradient-to-r from-[#db2777] to-[#ec4899] hover:opacity-90 disabled:opacity-30 transition-all flex justify-center items-center gap-2"
            >
              {connecting ? <Loader2 size={18} className="animate-spin" /> : <Plug size={18} />}
              Connect to {selectedPort || 'Device'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── UI: DASHBOARD (PINK THEME) ─────────────────────────────
  return (
    <main className="min-h-screen bg-white font-sans p-6 md:p-8 flex flex-col gap-5">
      <header className="flex justify-between items-center bg-[#fff0f5] border border-[#fbcfe8] p-4 rounded-2xl">
        <div className="flex items-center gap-3">
          <div className="bg-[#db2777] p-2 rounded-xl text-white">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-[14px] font-black text-[#831843] leading-none uppercase">Medical Dashboard</h2>
            <p className="text-[10px] font-bold text-[#ec4899] mt-1 uppercase tracking-tighter">{selectedPort} @ {selectedBaud} BAUD</p>
          </div>
        </div>
        <div className="flex gap-2">
          <div className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-full border ${connectedSTM32 ? 'text-green-600 bg-green-50 border-green-100' : 'text-red-500 bg-red-50 border-red-100'}`}>
            <Wifi size={12} /> {connectedSTM32 ? 'DEVICE LIVE' : 'DEVICE OFFLINE'}
          </div>
          <button onClick={() => setSetupDone(false)} className="text-[10px] font-bold text-[#ec4899] border border-[#fbcfe8] px-3 py-1.5 rounded-full hover:bg-[#fff0f5]">DISCONNECT</button>
        </div>
      </header>

      <div className="flex gap-4 items-stretch h-[280px]">
        <ChartCard 
          title="Historical Reference" 
          subtitle="Baseline Signal Pattern" 
          data={historicalBuffer} 
          className="flex-[3]" 
        />
        <div className="flex-[1] bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl p-6 flex flex-col justify-between">
          <div>
            <p className="text-[12px] font-bold text-[#ec4899] uppercase tracking-wider">Stroke Risk</p>
            <div className="flex items-baseline gap-1 mt-3">
              <span className="text-[60px] font-black text-[#831843]">23</span>
              <span className="text-[26px] font-extrabold text-[#831843]">%</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-[10px] w-full rounded-full bg-[#fce7f3] overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#f472b6] to-[#db2777]" style={{ width: '23%' }} />
            </div>
            <p className="text-[10px] font-bold text-[#db2777] text-right uppercase">Low Risk Correlation</p>
          </div>
        </div>
      </div>

      <ChartCard 
        title="STM32 Real-time ECG" 
        subtitle="Electrocardiogram Analysis" 
        live 
        data={stm32Buffer} 
        className="h-[280px]" 
      />

      <ChartCard 
        title="STM32 Real-time PCG" 
        subtitle="Phonocardiogram Analysis" 
        live 
        data={pcgBuffer} 
        waiting={!connectedSTM32} 
        className="h-[280px]" 
      />
    </main>
  );
}