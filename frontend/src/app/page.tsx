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
  ChevronDown, Loader2, AlertCircle, TrendingUp 
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

const blueChartOptions: ChartOptions<'line'> = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  elements: {
    point: { radius: 0 },
    line: { borderWidth: 2, tension: 0.4 }
  },
  scales: {
    x: { 
      display: true, 
      grid: { color: 'rgba(191, 219, 254, 0.35)', lineWidth: 0.5, tickLength: 0, drawTicks: false }, 
      border: { display: false },
      ticks: { display: false } 
    },
    y: {
      display: true,
      min: -1500,
      max: 1500,
      grid: { color: 'rgba(191, 219, 254, 0.35)', lineWidth: 0.5, tickLength: 0 },
      border: { display: false },
      ticks: { 
        color: '#93c5fd', 
        font: { size: 10, weight: 600 },
        stepSize: 750,
        callback: (value) => (Number(value) / 1000).toString()
      }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } }
};

// ─── Reusable Components ──────────────────────────────────────────────────────
const ChartCard = ({ title, subtitle, live = false, data, waiting = false, className = '' }: any) => (
  <div className={`bg-[#eff6ff] border border-[#bfdbfe] rounded-2xl px-5 pt-5 pb-4 flex flex-col relative ${className}`}>
    <div className="flex justify-between items-start mb-3">
      <div>
        <h3 className="text-[13px] font-bold text-[#1e3a8a] m-0 uppercase tracking-wider">{title}</h3>
        <p className="text-[10px] font-semibold text-[#3b82f6] mt-[3px]">{subtitle}</p>
      </div>
      {live && (
        <div className="flex items-center gap-[5px] text-[10px] font-bold text-[#2563eb] tracking-[0.1em]">
          <div className="w-[6px] h-[6px] rounded-full bg-[#2563eb] animate-pulse" />
          LIVE
        </div>
      )}
    </div>
    <div className="flex-1 relative w-full min-h-0">
      {waiting ? (
        <div className="absolute inset-0 flex flex-center justify-center items-center">
          <span className="text-[12px] font-semibold text-[#93c5fd]">Waiting for stream...</span>
        </div>
      ) : (
        <Line
          data={{
            labels,
            datasets: [{
              data,
              borderColor: '#2563eb',
              borderWidth: 1.8,
              tension: 0.4,
              pointRadius: 0,
            }]
          }}
          options={blueChartOptions}
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
    let sIdx = 0;
    wsS.onopen = () => setConnectedSTM32(true);
    wsS.onmessage = (e) => {
      const payload = JSON.parse(e.data);
      if (payload.stm32_ecg) {
        payload.stm32_ecg.forEach((val: number) => {
          sBuf[sIdx] = val;
          for (let g = 1; g <= 10; g++) sBuf[(sIdx + g) % MAX_POINTS] = null;
          sIdx = (sIdx + 1) % MAX_POINTS;
        });
        setStm32Buffer([...applyEMA(sBuf, 0.25)]);
      }
    };

    return () => { wsH.close(); wsS.close(); };
  }, [setupDone]);

  // ─── UI: SETUP SCREEN (BLUE THEME) ──────────────────────────
  if (!setupDone) {
    return (
      <div className="min-h-screen bg-[#f0f9ff] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-xl border border-[#bfdbfe] w-full max-w-md overflow-hidden">
          <div className="bg-gradient-to-r from-[#2563eb] to-[#3b82f6] px-8 py-8 text-white">
            <div className="flex items-center gap-3 mb-2">
              <Activity size={24} />
              <h1 className="text-xl font-bold tracking-tight">System Configuration</h1>
            </div>
            <p className="text-blue-100 text-[11px] opacity-90">Select hardware port to begin monitoring</p>
          </div>

          <div className="p-8 space-y-6">
            <div>
              <label className="block text-[10px] font-bold text-[#1e3a8a] uppercase tracking-widest mb-3">Serial Port</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select 
                    value={selectedPort} 
                    onChange={e => setSelectedPort(e.target.value)}
                    className="w-full appearance-none pl-4 pr-10 py-3 border border-[#bfdbfe] rounded-xl text-sm text-[#1e3a8a] bg-[#eff6ff] focus:ring-2 focus:ring-[#60a5fa] outline-none transition-all"
                  >
                    <option value="">Choose Port...</option>
                    {ports.map(p => <option key={p.port} value={p.port}>{p.port}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#3b82f6]" />
                </div>
                <button onClick={fetchPorts} className="p-3 border border-[#bfdbfe] rounded-xl text-[#3b82f6] hover:bg-[#dbeafe] transition-all">
                  {portsLoading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#1e3a8a] uppercase tracking-widest mb-3">Baud Rate</label>
              <div className="grid grid-cols-4 gap-2">
                {COMMON_BAUDS.map(b => (
                  <button 
                    key={b} 
                    onClick={() => setSelectedBaud(b)}
                    className={`py-2 rounded-lg text-[10px] font-bold border transition-all ${selectedBaud === b ? 'bg-[#2563eb] border-[#2563eb] text-white' : 'bg-white border-[#bfdbfe] text-[#3b82f6] hover:bg-[#eff6ff]'}`}
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
              className="w-full py-4 rounded-2xl text-sm font-bold text-white bg-gradient-to-r from-[#2563eb] to-[#3b82f6] hover:opacity-90 disabled:opacity-30 transition-all flex justify-center items-center gap-2"
            >
              {connecting ? <Loader2 size={18} className="animate-spin" /> : <Plug size={18} />}
              Connect to {selectedPort || 'Device'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── UI: DASHBOARD (BLUE THEME) ─────────────────────────────
  return (
    <main className="min-h-screen bg-white font-sans p-6 md:p-8 flex flex-col gap-5">
      <header className="flex justify-between items-center bg-[#eff6ff] border border-[#bfdbfe] p-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-[#2563eb] p-2 rounded-xl text-white">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-[14px] font-black text-[#1e3a8a] leading-none uppercase">Medical Dashboard</h2>
            <p className="text-[10px] font-bold text-[#3b82f6] mt-1 uppercase tracking-tighter">{selectedPort} @ {selectedBaud} BAUD</p>
          </div>
        </div>
        <div className="flex gap-2">
          <div className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-full border ${connectedSTM32 ? 'text-blue-600 bg-blue-50 border-blue-100' : 'text-red-500 bg-red-50 border-red-100'}`}>
            <Wifi size={12} /> {connectedSTM32 ? 'DEVICE LIVE' : 'DEVICE OFFLINE'}
          </div>
          <button onClick={() => setSetupDone(false)} className="text-[10px] font-bold text-[#3b82f6] border border-[#bfdbfe] px-3 py-1.5 rounded-full hover:bg-[#dbeafe] transition-colors">DISCONNECT</button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-[580px]">
        {/* Card 1: Historical Reference */}
        <ChartCard 
          title="Historical Reference" 
          subtitle="Baseline Pattern" 
          data={historicalBuffer} 
          className="shadow-sm" 
        />
        
        {/* Card 2: STM32 Real-time ECG */}
        <ChartCard 
          title="STM32 Real-time ECG" 
          subtitle="Electrocardiogram" 
          live 
          data={stm32Buffer} 
          className="shadow-sm" 
        />
        
        {/* Card 3: STM32 Real-time PCG */}
        <ChartCard 
          title="STM32 Real-time PCG" 
          subtitle="Phonocardiogram" 
          live 
          data={[]} 
          waiting 
          className="shadow-sm" 
        />
        
        {/* Card 4: Stroke Risk Correlation */}
        <div className="bg-[#eff6ff] border border-[#bfdbfe] rounded-2xl p-8 flex flex-col justify-center relative shadow-sm">
          <div className="absolute top-8 left-8 flex items-start gap-3">
            <TrendingUp className="text-[#2563eb]" size={28} strokeWidth={2.5} />
            <div>
              <p className="text-[16px] font-bold text-[#1e3a8a] leading-none">Stroke Risk Correlation</p>
              <p className="text-[12px] font-medium text-[#3b82f6] mt-1">Real-time Analysis</p>
            </div>
          </div>
          
          <div className="flex items-baseline gap-1 mt-10 mb-8 px-2">
            <span className="text-[90px] font-black text-[#1e3a8a] leading-none tracking-tighter">23</span>
            <span className="text-[36px] font-extrabold text-[#2563eb]">%</span>
            <div className="ml-6 flex flex-col justify-end pb-3">
              <p className="text-[16px] font-bold text-[#1e3a8a]">Low Risk</p>
              <p className="text-[12px] font-medium text-[#3b82f6]">Classification Level</p>
            </div>
          </div>
          
          <div className="flex flex-col gap-2 w-full mt-auto">
            <div className="h-[16px] w-full rounded-full bg-[#dbeafe] overflow-hidden">
              <div className="h-full bg-[#2563eb] rounded-full" style={{ width: '23%' }} />
            </div>
            <div className="flex justify-between px-1">
              <span className="text-[10px] font-bold text-[#60a5fa]">0%</span>
              <span className="text-[10px] font-bold text-[#60a5fa]">50%</span>
              <span className="text-[10px] font-bold text-[#60a5fa]">100%</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}