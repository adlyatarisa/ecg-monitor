'use client';

import { useEffect, useState, useMemo } from 'react';
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
  Activity, Wifi, RefreshCw, Plug, 
  ChevronDown, Loader2, AlertCircle
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

// ─── Constants & Utils 
const MAX_POINTS = 1500;  
const labels = Array.from({ length: MAX_POINTS }, (_, i) => i);
const BACKEND = 'http://localhost:8087';
const WS_URL_STM32 = 'ws://localhost:8087/ws';
const WS_URL_HISTORICAL = 'ws://localhost:8080';
const COMMON_BAUDS = [9600, 38400, 115200, 230400];

const buildChartOptions = (yMin: number | undefined, yMax: number | undefined): ChartOptions<'line'> => ({
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
      min: yMin,
      max: yMax,
      grid: { color: '#fce7f3', lineWidth: 0.4 },
      ticks: { color: '#f9a8d4', font: { size: 10, weight: 600 } }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } }
});

const ECG_OPTIONS = buildChartOptions(-400, 400);   // filtered ECG, DC removed
const PCG_OPTIONS = buildChartOptions(-600, 600);   // filtered PCG (20–150 Hz)
const ECG_RAW_OPTIONS = buildChartOptions(0, 4095); // raw ADC 12-bit
const PCG_RAW_OPTIONS = buildChartOptions(0, 4095); // raw ADC 12-bit
const AUTO_OPTIONS = buildChartOptions(undefined, undefined); // auto-scale
const HISTORICAL_OPTIONS = buildChartOptions(-2500, 2500);

// Compute simple stats for a buffer (ignoring nulls)
function computeStats(buf: (number | null)[]) {
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (const v of buf) {
    if (v === null || v === undefined) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  if (count === 0) return { min: 0, max: 0, mean: 0, pp: 0 };
  return { min, max, mean: sum / count, pp: max - min };
}

function pearsonCorrelation(a: (number | null)[], b: (number | null)[]): number {
  const n = Math.min(a.length, b.length);

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (a[i] !== null && a[i] !== undefined && b[i] !== null && b[i] !== undefined) {
      xs.push(a[i] as number);
      ys.push(b[i] as number);
    }
  }
  if (xs.length < 2) return NaN;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < xs.length; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / xs.length;
  const meanY = sumY / ys.length;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov  += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return NaN;

  return cov / Math.sqrt(varX * varY);
}
function riskFromCorrelation(r: number): { pct: number; label: string; color: string } {
  if (isNaN(r)) return { pct: 0, label: 'INSUFFICIENT DATA', color: '#9ca3af' };
  const absR = Math.abs(r);
  const riskPct = Math.round((1 - absR) * 100);
  if (riskPct <= 25)      return { pct: riskPct, label: 'LOW RISK CORRELATION',      color: '#16a34a' };
  if (riskPct <= 50)      return { pct: riskPct, label: 'MODERATE RISK CORRELATION', color: '#ca8a04' };
  if (riskPct <= 75)      return { pct: riskPct, label: 'HIGH RISK CORRELATION',     color: '#ea580c' };
  return                          { pct: riskPct, label: 'VERY HIGH RISK',           color: '#dc2626' };
}

//  Reusable Components 
const ChartCard = ({ title, subtitle, live = false, data, waiting = false, className = '', options = ECG_OPTIONS, showStats = false }: any) => {
  const stats = showStats && data ? computeStats(data) : null;
  const weak = stats ? stats.pp < 30 : false;
  return (
  <div className={`bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl px-5 pt-5 pb-4 flex flex-col relative ${className}`}>
    <div className="flex justify-between items-start mb-3">
      <div>
        <h3 className="text-[13px] font-bold text-[#831843] m-0 uppercase tracking-wider">{title}</h3>
        <p className="text-[10px] font-semibold text-[#ec4899] mt-[3px]">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        {stats && (
          <div className="flex gap-3 text-[9px] font-bold text-[#831843] tracking-wider">
            <span>MIN <span className="text-[#db2777]">{stats.min.toFixed(0)}</span></span>
            <span>MAX <span className="text-[#db2777]">{stats.max.toFixed(0)}</span></span>
            <span className={weak ? 'text-amber-600' : ''}>
              P-P <span className={weak ? 'text-amber-600' : 'text-[#db2777]'}>{stats.pp.toFixed(0)}</span>
              {weak && ' ⚠'}
            </span>
          </div>
        )}
        {live && (
          <div className="flex items-center gap-[5px] text-[10px] font-bold text-[#db2777] tracking-[0.1em]">
            <div className="w-[7px] h-[7px] rounded-full bg-[#db2777] animate-pulse" />
            LIVE
          </div>
        )}
      </div>
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
          options={options}
        />
      )}
    </div>
  </div>
  );
};

export default function Dashboard() {
  const [setupDone, setSetupDone] = useState(false);
  const [ports, setPorts] = useState<{port: string, description: string}[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [selectedBaud, setSelectedBaud] = useState(115200);
  const [portsLoading, setPortsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Data States
  const [, setConnectedHistorical] = useState(false);
  const [connectedSTM32, setConnectedSTM32] = useState(false);
  const [historicalBuffer, setHistoricalBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [stm32Buffer, setStm32Buffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [pcgBuffer, setPcgBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [stm32RawBuffer, setStm32RawBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [pcgRawBuffer, setPcgRawBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [useRaw, setUseRaw] = useState(false);
  const [autoScale, setAutoScale] = useState(false);

  // ─── Pearson Correlation (Historical Reference ↔ STM32 PCG) ───
  const pearsonR = useMemo(
    () => pearsonCorrelation(historicalBuffer, pcgBuffer),
    [historicalBuffer, pcgBuffer]
  );
  const risk = useMemo(() => riskFromCorrelation(pearsonR), [pearsonR]);

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
    let sBuf = Array(MAX_POINTS).fill(null);      // filtered ECG
    let pBuf = Array(MAX_POINTS).fill(null);      // filtered PCG
    let sRawBuf = Array(MAX_POINTS).fill(null);   // raw ECG
    let pRawBuf = Array(MAX_POINTS).fill(null);   // raw PCG
    let sIdx = 0;
    let pIdx = 0;
    let sRawIdx = 0;
    let pRawIdx = 0;
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

        // Filtered data (bandpass + notch + Kalman)
        const ecgFiltered = payload.stm32_ecg;
        const pcgFiltered = payload.stm32_pcg;
        // Raw ADC data
        const ecgRaw = payload.stm32_ecg_raw;
        const pcgRaw = payload.stm32_pcg_raw;

        if (ecgFiltered && Array.isArray(ecgFiltered)) {
          ecgFiltered.forEach((val: number) => {
            sBuf[sIdx] = val;
            sBuf[(sIdx + 1) % MAX_POINTS] = null;
            sIdx = (sIdx + 1) % MAX_POINTS;
          });
          setStm32Buffer([...sBuf]);
        }
        if (ecgRaw && Array.isArray(ecgRaw)) {
          ecgRaw.forEach((val: number) => {
            sRawBuf[sRawIdx] = val;
            sRawBuf[(sRawIdx + 1) % MAX_POINTS] = null;
            sRawIdx = (sRawIdx + 1) % MAX_POINTS;
          });
          setStm32RawBuffer([...sRawBuf]);
        }
        if (pcgFiltered && Array.isArray(pcgFiltered)) {
          pcgFiltered.forEach((val: number) => {
            pBuf[pIdx] = val;
            pBuf[(pIdx + 1) % MAX_POINTS] = null;
            pIdx = (pIdx + 1) % MAX_POINTS;
          });
          setPcgBuffer([...pBuf]);
        }
        if (pcgRaw && Array.isArray(pcgRaw)) {
          pcgRaw.forEach((val: number) => {
            pRawBuf[pRawIdx] = val;
            pRawBuf[(pRawIdx + 1) % MAX_POINTS] = null;
            pRawIdx = (pRawIdx + 1) % MAX_POINTS;
          });
          setPcgRawBuffer([...pRawBuf]);
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

  return (
    <main className="min-h-screen bg-white font-sans p-6 md:p-8 flex flex-col gap-5">
      <header className="flex justify-between items-center bg-[#fff0f5] border border-[#fbcfe8] p-4 rounded-2xl">
        <div className="flex items-center gap-3">
          <div className="bg-[#db2777] p-2 rounded-xl text-white">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-[14px] font-black text-[#831843] leading-none uppercase">Heartify</h2>
            <p className="text-[10px] font-bold text-[#ec4899] mt-1 uppercase tracking-tighter">{selectedPort} @ {selectedBaud} BAUD</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setUseRaw(!useRaw)}
            className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-full border transition-all ${useRaw ? 'text-amber-600 bg-amber-50 border-amber-200' : 'text-[#db2777] bg-[#fff0f5] border-[#fbcfe8]'}`}
          >
            {useRaw ? 'RAW' : 'FILTERED'}
          </button>
          <button 
            onClick={() => setAutoScale(!autoScale)}
            className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-full border transition-all ${autoScale ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-[#db2777] bg-[#fff0f5] border-[#fbcfe8]'}`}
            title="Toggle Y-axis auto-scaling"
          >
            {autoScale ? 'AUTO Y' : 'FIXED Y'}
          </button>
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
          options={HISTORICAL_OPTIONS}
          className="flex-[3]" 
        />
        <div className="flex-[1] bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl p-6 flex flex-col justify-between">
          <div>
            <p className="text-[12px] font-bold text-[#ec4899] uppercase tracking-wider">Stroke Risk</p>
            <div className="flex items-baseline gap-1 mt-3">
              <span className="text-[60px] font-black text-[#831843]">{risk.pct}</span>
              <span className="text-[26px] font-extrabold text-[#831843]">%</span>
            </div>
            <p className="text-[10px] font-semibold text-[#be185d] mt-1">
              Pearson r = {isNaN(pearsonR) ? '—' : pearsonR.toFixed(4)}
            </p>
          </div>
          <div className="space-y-2">
            <div className="h-[10px] w-full rounded-full bg-[#fce7f3] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${risk.pct}%`, backgroundColor: risk.color }}
              />
            </div>
            <p className="text-[10px] font-bold text-right uppercase" style={{ color: risk.color }}>
              {risk.label}
            </p>
          </div>
        </div>
      </div>

      <ChartCard 
        title="STM32 Real-time ECG" 
        subtitle={useRaw ? "Raw ADC (unfiltered)" : "Electrocardiogram Analysis (Kalman filtered)"} 
        live 
        data={useRaw ? stm32RawBuffer : stm32Buffer} 
        options={autoScale ? AUTO_OPTIONS : (useRaw ? ECG_RAW_OPTIONS : ECG_OPTIONS)}
        showStats
        className="h-[280px]" 
      />

      <ChartCard 
        title="STM32 Real-time PCG" 
        subtitle={useRaw ? "Raw ADC (unfiltered)" : "Phonocardiogram Analysis (Kalman filtered)"} 
        live 
        data={useRaw ? pcgRawBuffer : pcgBuffer} 
        options={autoScale ? AUTO_OPTIONS : (useRaw ? PCG_RAW_OPTIONS : PCG_OPTIONS)}
        showStats
        waiting={!connectedSTM32} 
        className="h-[280px]" 
      />
    </main>
  );
}