'use client';

import { useEffect, useState, useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import {
  Activity, HeartPulse, Stethoscope, Wifi, WifiOff,
  RefreshCw, Plug, ChevronDown, Loader2, CheckCircle2, AlertCircle
} from 'lucide-react';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Title, Tooltip, Legend, Filler
);

const BACKEND = 'http://localhost:8087';
const WS_URL  = 'ws://localhost:8087/ws';
const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800];

// ─── EMA smoothing (frontend layer) ──────────────────────────
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

function calculatePearsonCorrelation(x: number[], y: number[]) {
  if (!x || !y || x.length !== y.length) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }
  const num = (n * sumXY) - (sumX * sumY);
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

// ─── Types ────────────────────────────────────────────────────
interface PortInfo { port: string; description: string; }

// ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  // ── Setup state ──────────────────────────────────────────
  const [setupDone, setSetupDone]         = useState(false);
  const [ports, setPorts]                 = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort]   = useState('');
  const [selectedBaud, setSelectedBaud]   = useState(115200);
  const [portsLoading, setPortsLoading]   = useState(false);
  const [connecting, setConnecting]       = useState(false);
  const [connectError, setConnectError]   = useState('');

  // ── Dashboard state ───────────────────────────────────────
  const [loading, setLoading]             = useState(true);
  const [connected, setConnected]         = useState(false);
  const [stm32Connected, setStm32Connected] = useState(false);
  const [stm32Buffer, setStm32Buffer]     = useState<(number | null)[]>(Array(1000).fill(null));
  const [stm32RawBuffer, setStm32RawBuffer] = useState<(number | null)[]>(Array(1000).fill(null));
  const [showFiltered, setShowFiltered]   = useState(true);
  const [sweepBuffer, setSweepBuffer]     = useState<(number | null)[]>(Array(1000).fill(null));
  const MAX_POINTS = 1000;

  // ── Fetch COM ports ───────────────────────────────────────
  const fetchPorts = async () => {
    setPortsLoading(true);
    setConnectError('');
    try {
      const res  = await fetch(`${BACKEND}/ports`);
      const data = await res.json();
      setPorts(data.ports ?? []);
      if (data.ports?.length === 1) setSelectedPort(data.ports[0].port);
    } catch {
      setConnectError('Backend tidak merespons. Pastikan stm32_server.py sudah dijalankan.');
    } finally {
      setPortsLoading(false);
    }
  };

  // Fetch ports on mount
  useEffect(() => { fetchPorts(); }, []);

  // Tampilkan dashboard segera setelah setup selesai
  // (tidak perlu tunggu data WebSocket pertama)
  useEffect(() => { if (setupDone) setLoading(false); }, [setupDone]);

  // ── Connect device ────────────────────────────────────────
  const connectDevice = async () => {
    if (!selectedPort) { setConnectError('Pilih COM port terlebih dahulu.'); return; }
    setConnecting(true);
    setConnectError('');
    try {
      const res  = await fetch(`${BACKEND}/connect`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ port: selectedPort, baud: selectedBaud }),
      });
      const data = await res.json();
      if (data.ok) setSetupDone(true);
      else setConnectError(data.error ?? 'Koneksi gagal.');
    } catch {
      setConnectError('Tidak dapat terhubung ke backend.');
    } finally {
      setConnecting(false);
    }
  };


  useEffect(() => {
    if (!setupDone) return;
    const ws = new WebSocket('ws://localhost:8080');
    let ecgBuf: (number | null)[] = Array(MAX_POINTS).fill(null);
    let idx = 0;
    ws.onopen  = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      const payload = JSON.parse(e.data);
      if (payload.error) return;
      for (let i = 0; i < payload.ecg.length; i++) {
        ecgBuf[idx] = payload.ecg[i];
        for (let g = 1; g <= 15; g++) ecgBuf[(idx + g) % MAX_POINTS] = null;
        idx = (idx + 1) % MAX_POINTS;
      }
      setSweepBuffer([...ecgBuf]);
      setLoading(false);
    };
    return () => ws.close();
  }, [setupDone]);

  // ── STM32 Real-Time ECG (ws://localhost:8087/ws) ──────────
  useEffect(() => {
    if (!setupDone) return;
    let stm32Buf:    (number | null)[] = Array(MAX_POINTS).fill(null);
    let stm32RawBuf: (number | null)[] = Array(MAX_POINTS).fill(null);
    let stm32Idx = 0;

    const connect = () => {
      let ws: WebSocket;
      try { ws = new WebSocket(WS_URL); } catch { return; }
      ws.onopen  = () => setStm32Connected(true);
      ws.onerror = () => setStm32Connected(false);
      ws.onclose = () => { setStm32Connected(false); setTimeout(connect, 3000); };
      ws.onmessage = (e) => {
        const payload = JSON.parse(e.data);
        if (!payload.stm32_ecg) return;
        const filtered: number[] = payload.stm32_ecg;
        const raw: number[]      = payload.stm32_ecg_raw ?? filtered;
        for (let i = 0; i < filtered.length; i++) {
          stm32Buf[stm32Idx]    = filtered[i];
          stm32RawBuf[stm32Idx] = raw[i];
          for (let g = 1; g <= 10; g++) {
            const gi = (stm32Idx + g) % MAX_POINTS;
            stm32Buf[gi] = null; stm32RawBuf[gi] = null;
          }
          stm32Idx = (stm32Idx + 1) % MAX_POINTS;
        }
        setStm32Buffer([...stm32Buf]);
        setStm32RawBuffer([...stm32RawBuf]);
        setLoading(false);
      };
      return ws;
    };

    const ws = connect();
    return () => ws?.close();
  }, [setupDone]);

  const labels = Array.from({ length: MAX_POINTS }, (_, i) => i);

  const chartOptions = {
    animation: false as const,
    responsive: true,
    maintainAspectRatio: false,
    elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0.1 } },
    scales: {
      x: {
        display: true, min: 0, max: MAX_POINTS,
        grid: { color: '#f1f5f9', tickLength: 4 },
        ticks: { color: '#94a3b8', font: { size: 9 }, stepSize: 200 },
        title: { display: true, text: 'Samples', color: '#94a3b8', font: { size: 10 } }
      },
      y: {
        display: true, beginAtZero: false, grace: '5%',
        grid: { color: '#f1f5f9', tickLength: 4 },
        ticks: { color: '#94a3b8', font: { size: 9 }, callback: (v: any) => v.toLocaleString() },
        title: { display: true, text: 'Raw Amplitude (uV)', color: '#94a3b8', font: { size: 10 } }
      }
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } }
  };

  const simValue   = Math.random() * 10;
  const simLabel   = simValue.toFixed(1);
  const simHistory = [5.6, 6.2, 5.8, 7.1, 6.8, 6.5, 7.0, Number(simLabel)];

  // ── Setup Screen ──────────────────────────────────────────
  if (!setupDone) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-emerald-50/30 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-md overflow-hidden">

          {/* Header band */}
          <div className="bg-gradient-to-r from-emerald-600 to-teal-600 px-8 py-6 text-white">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center">
                <Activity size={20} />
              </div>
              <h1 className="text-lg font-bold tracking-tight">ECG Monitor</h1>
            </div>
            <p className="text-emerald-100 text-xs ml-12">Konfigurasi koneksi perangkat STM32</p>
          </div>

          <div className="px-8 py-7 space-y-5">

            {/* COM Port */}
            <div>
              <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                COM Port
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select
                    id="select-com-port"
                    value={selectedPort}
                    onChange={e => setSelectedPort(e.target.value)}
                    className="w-full appearance-none pl-3 pr-8 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400 transition-all"
                  >
                    <option value="">— Pilih COM Port —</option>
                    {ports.map(p => (
                      <option key={p.port} value={p.port}>
                        {p.port}  {p.description !== p.port ? `— ${p.description}` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                </div>
                <button
                  id="btn-refresh-ports"
                  onClick={fetchPorts}
                  disabled={portsLoading}
                  title="Refresh daftar port"
                  className="w-10 h-10 flex items-center justify-center border border-gray-200 rounded-lg text-gray-400 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 transition-all disabled:opacity-40"
                >
                  {portsLoading
                    ? <Loader2 size={14} className="animate-spin" />
                    : <RefreshCw size={14} />
                  }
                </button>
              </div>
              {ports.length === 0 && !portsLoading && (
                <p className="text-[11px] text-amber-500 mt-1.5 flex items-center gap-1">
                  <AlertCircle size={11} /> Tidak ada port ditemukan. Pastikan perangkat terhubung.
                </p>
              )}
            </div>

            {/* Baud Rate */}
            <div>
              <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                Baud Rate
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {COMMON_BAUDS.map(b => (
                  <button
                    key={b}
                    id={`btn-baud-${b}`}
                    onClick={() => setSelectedBaud(b)}
                    className={`py-2 rounded-lg text-[11px] font-medium border transition-all ${
                      selectedBaud === b
                        ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-emerald-300 hover:text-emerald-600'
                    }`}
                  >
                    {b >= 1000 ? `${b / 1000}K` : b}
                  </button>
                ))}
              </div>
            </div>

            {/* Connection info summary */}
            {selectedPort && (
              <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 flex items-center gap-3">
                <Plug size={14} className="text-emerald-500 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-gray-700">{selectedPort}</div>
                  <div className="text-[11px] text-gray-400">{selectedBaud.toLocaleString()} baud · 200 Hz sample rate · DSP active</div>
                </div>
              </div>
            )}

            {/* Error */}
            {connectError && (
              <div className="bg-red-50 border border-red-200 text-red-600 text-xs rounded-xl px-4 py-3 flex items-start gap-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                {connectError}
              </div>
            )}

            {/* Connect button */}
            <button
              id="btn-connect-device"
              onClick={connectDevice}
              disabled={connecting || !selectedPort}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm flex items-center justify-center gap-2"
            >
              {connecting
                ? <><Loader2 size={15} className="animate-spin" /> Menghubungkan...</>
                : <><Plug size={15} /> Connect to {selectedPort || 'Device'}</>
              }
            </button>
          </div>

          {/* Footer note */}
          <div className="border-t border-gray-100 px-8 py-3 bg-gray-50">
            <p className="text-[10px] text-gray-400 text-center">
              Pastikan <code className="font-mono bg-gray-100 px-1 rounded">stm32_server.py</code> sudah berjalan sebelum connect
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading Screen (after setup, waiting for WS data) ────
  if (loading) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center text-gray-400">
      <Activity size={40} className="animate-pulse mb-4" />
      <div className="text-base font-medium tracking-wide">Menunggu data dari {selectedPort}...</div>
    </div>
  );

  // ── Main Dashboard ────────────────────────────────────────
  return (
    <main className="min-h-screen bg-gray-50 text-gray-800 font-sans p-5 md:p-8 flex flex-col">
      {/* Header */}
      <header className="flex flex-wrap gap-4 items-center justify-between bg-white border border-gray-200 rounded-xl p-4 mb-6 shadow-sm">
        <div className="flex items-center gap-3">
          <Activity size={24} className="text-gray-700" />
          <span className="text-lg font-semibold text-gray-800 tracking-tight">ECG Monitor</span>
          <span className="text-[11px] text-gray-400 font-mono bg-gray-100 px-2 py-0.5 rounded-md">
            {selectedPort} · {selectedBaud.toLocaleString()} baud
          </span>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <div className="flex items-center gap-2 text-xs font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-full border border-green-200">
              <Wifi size={13} /> Historical
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs font-medium text-red-600 bg-red-50 px-3 py-1.5 rounded-full border border-red-200">
              <WifiOff size={13} /> Historical Disconnected
            </div>
          )}
          <button
            id="btn-change-device"
            onClick={() => { setSetupDone(false); setLoading(true); }}
            className="text-[11px] font-medium text-gray-400 hover:text-gray-600 border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-300 transition-all"
          >
            Ganti Perangkat
          </button>
        </div>
      </header>

      {/* Content Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 flex-1">

        {/* Charts Panel */}
        <div className="xl:col-span-9 flex flex-col min-h-[500px]">
          <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm flex-1 flex flex-col">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-sm font-semibold text-gray-700 tracking-wide">Signal Analysis</h2>
              <span className="text-xs font-medium text-gray-400">Live Stream</span>
            </div>

            <div className="flex-1 flex flex-col gap-4">

              {/* Chart 1: Historical Reference */}
              <div className="flex-1 w-full bg-gray-50 rounded-lg border border-gray-100 relative p-3 flex flex-col">
                <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 mb-2">
                  <Activity size={12} /> Historical Reference (Raw)
                </div>
                <div className="flex-1 w-full">
                  <Line
                    data={{
                      labels,
                      datasets: [{
                        label: 'Historical ECG',
                        data: sweepBuffer,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59,130,246,0.04)',
                        borderWidth: 1.5, fill: true, tension: 0.3
                      }]
                    }}
                    options={chartOptions}
                  />
                </div>
              </div>

              {/* Chart 2: STM32 Real-Time ECG */}
              <div className="flex-1 w-full bg-gray-50 rounded-lg border border-gray-100 relative p-3 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500">
                    <HeartPulse size={12} /> STM32 Real-Time ECG
                    <span className="text-[10px] text-gray-400 font-normal">({selectedPort})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      id="btn-toggle-dsp"
                      onClick={() => setShowFiltered(f => !f)}
                      className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
                        showFiltered
                          ? 'text-indigo-700 bg-indigo-50 border-indigo-200'
                          : 'text-gray-500 bg-gray-100 border-gray-200'
                      }`}
                    >
                      {showFiltered ? 'DSP Filtered' : '〜 Raw Signal'}
                    </button>
                    {stm32Connected ? (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                        <Wifi size={10} /> Live
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                        <WifiOff size={10} /> Connecting...
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex-1 w-full relative">
                  {!stm32Connected && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-300 z-10 pointer-events-none">
                      <Wifi size={18} className="mb-1.5 animate-pulse" />
                      <span className="text-[11px] font-medium">Menunggu data dari {selectedPort}...</span>
                    </div>
                  )}
                  <Line
                    data={{
                      labels,
                      datasets: [{
                        label: showFiltered ? 'STM32 ECG (Filtered)' : 'STM32 ECG (Raw)',
                        data: showFiltered ? applyEMA(stm32Buffer, 0.25) : stm32RawBuffer,
                        borderColor: stm32Connected ? (showFiltered ? '#10b981' : '#f59e0b') : '#94a3b8',
                        backgroundColor: stm32Connected
                          ? (showFiltered ? 'rgba(16,185,129,0.04)' : 'rgba(245,158,11,0.04)')
                          : 'transparent',
                        borderWidth: showFiltered ? 1.5 : 1,
                        fill: true,
                        tension: showFiltered ? 0.4 : 0.1,
                        pointRadius: 0,
                        spanGaps: false
                      }]
                    }}
                    options={{
                      ...chartOptions,
                      scales: {
                        ...chartOptions.scales,
                        y: {
                          ...chartOptions.scales.y,
                          title: {
                            display: true,
                            text: showFiltered ? 'Amplitude — DSP Filtered (uV)' : 'Amplitude — Raw ADC',
                            color: '#94a3b8', font: { size: 10 }
                          }
                        }
                      }
                    }}
                  />
                </div>
              </div>

              {/* Chart 3: STM32 Real-Time PCG */}
              <div className="flex-1 w-full bg-gray-50 rounded-lg border border-gray-100 relative p-3 flex flex-col justify-center items-center">
                <div className="absolute top-3 left-4 flex items-center gap-2 text-[11px] font-medium text-gray-500 z-10">
                  <Stethoscope size={12} /> STM32 Real-Time PCG
                </div>
                <div className="flex flex-col items-center justify-center text-gray-300">
                  <Wifi size={18} className="mb-1.5" />
                  <span className="text-[11px] font-medium">Waiting for stream...</span>
                </div>
                <div className="w-full flex-1 opacity-15 pointer-events-none mt-3">
                  <Line
                    data={{ labels, datasets: [{ data: Array(1000).fill(0), borderColor: '#94a3b8', borderWidth: 1 }] }}
                    options={chartOptions}
                  />
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* Right Panel */}
        <div className="xl:col-span-3 flex flex-col gap-6">
          <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm flex-1 flex flex-col">
            <h3 className="text-xs font-semibold text-gray-500 tracking-wide mb-5 text-center uppercase">Stroke Risk Correlation</h3>

            <div className="flex flex-col items-center justify-center py-6 px-4 bg-gray-50 border border-gray-100 rounded-xl mb-6">
              <div className="text-5xl font-bold text-gray-800 mb-1">
                {simLabel}<span className="text-xl text-gray-400 ml-0.5">%</span>
              </div>
              <div className="text-[10px] font-medium text-gray-400 tracking-widest mb-3 uppercase">Similarity</div>
              <div className="text-[11px] font-semibold text-green-700 bg-green-50 px-4 py-1.5 rounded-full border border-green-200 uppercase tracking-wider">
                Low Risk
              </div>
            </div>

            <div className="flex-1 flex flex-col justify-end gap-5">
              <div>
                <h4 className="text-[10px] font-semibold text-gray-400 tracking-wider mb-2 uppercase">Correlation History</h4>
                <div className="h-[80px] w-full">
                  <Bar
                    data={{
                      labels: ['1','2','3','4','5','6','7','8'],
                      datasets: [{
                        data: simHistory,
                        backgroundColor: ['#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#3b82f6'],
                        borderRadius: 4
                      }]
                    }}
                    options={{ ...chartOptions, scales: { x: { display: false }, y: { display: false } } }}
                  />
                </div>
              </div>

              <div>
                <h4 className="text-[10px] font-semibold text-gray-400 tracking-wider mb-2 uppercase">Compared Signal</h4>
                <div className="h-[80px] w-full bg-gray-50 rounded-lg p-2 border border-gray-100 relative">
                  <Line
                    data={{
                      labels: labels.slice(0, 80),
                      datasets: [
                        { data: sweepBuffer.slice(0, 80), borderColor: '#3b82f6', borderWidth: 1.5 },
                        { data: [], borderColor: '#d1d5db', borderWidth: 1 }
                      ]
                    }}
                    options={{ ...chartOptions, scales: { x: { display: false }, y: { display: false } } }}
                  />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-red-300" />
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </main>
  );
}
