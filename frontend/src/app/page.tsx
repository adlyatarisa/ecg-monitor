'use client';

import { useEffect, useState } from 'react';
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
import { Activity, HeartPulse, Stethoscope, Wifi, WifiOff } from 'lucide-react';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

function calculatePearsonCorrelation(x: number[], y: number[]) {
  if (!x || !y) return 0;
  if (x.length !== y.length) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const numerator = (n * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  const MAX_POINTS = 1000;
  const [sweepBuffer, setSweepBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080');

    let ecgBuffer: (number | null)[] = Array(MAX_POINTS).fill(null);
    let currentIndex = 0;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.error) return;

      const newEcg = payload.ecg;

      for (let i = 0; i < newEcg.length; i++) {
        ecgBuffer[currentIndex] = newEcg[i];

        for (let gap = 1; gap <= 15; gap++) {
          const gapIndex = (currentIndex + gap) % MAX_POINTS;
          ecgBuffer[gapIndex] = null;
        }

        currentIndex = (currentIndex + 1) % MAX_POINTS;
      }

      setSweepBuffer([...ecgBuffer]);
      setLoading(false);
    };

    ws.onerror = () => setConnected(false);

    return () => ws.close();
  }, []);

  const labels = Array.from({ length: MAX_POINTS }, (_, i) => i);

  const chartOptions = {
    animation: false as const,
    responsive: true,
    maintainAspectRatio: false,
    elements: {
      point: { radius: 0 },
      line: { borderWidth: 1.5, tension: 0.1 }
    },
    scales: {
      x: {
        display: true,
        min: 0,
        max: MAX_POINTS,
        grid: { color: '#f1f5f9', tickLength: 4 },
        ticks: { color: '#94a3b8', font: { size: 9 }, stepSize: 200 },
        title: { display: true, text: 'Samples', color: '#94a3b8', font: { size: 10 } }
      },
      y: {
        display: true,
        beginAtZero: false,
        grace: '5%',
        grid: { color: '#f1f5f9', tickLength: 4 },
        ticks: { 
          color: '#94a3b8', 
          font: { size: 9 },
          callback: (value: any) => value.toLocaleString() 
        },
        title: { display: true, text: 'Raw Amplitude (uV)', color: '#94a3b8', font: { size: 10 } }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false }
    }
  };

  const simValue = Math.random() * 10;
  const simLabel = simValue.toFixed(1);
  const simHistory = [5.6, 6.2, 5.8, 7.1, 6.8, 6.5, 7.0, Number(simLabel)];

  if (loading) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center text-gray-400">
      <Activity size={40} className="animate-pulse mb-4" />
      <div className="text-base font-medium tracking-wide">Connecting to data source...</div>
    </div>
  );

  return (
    <main className="min-h-screen bg-gray-50 text-gray-800 font-sans p-5 md:p-8 flex flex-col">
      {/* Header */}
      <header className="flex flex-wrap gap-4 items-center justify-between bg-white border border-gray-200 rounded-xl p-4 mb-6 shadow-sm">
        <div className="flex items-center gap-3">
          <Activity size={24} className="text-gray-700" />
          <span className="text-lg font-semibold text-gray-800 tracking-tight">ECG Monitor</span>
        </div>
        <div className="flex items-center gap-3">
          {connected ? (
            <div className="flex items-center gap-2 text-xs font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-full border border-green-200">
              <Wifi size={13} /> Connected
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs font-medium text-red-600 bg-red-50 px-3 py-1.5 rounded-full border border-red-200">
              <WifiOff size={13} /> Disconnected
            </div>
          )}
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
                        backgroundColor: 'rgba(59, 130, 246, 0.04)',
                        borderWidth: 1.5,
                        fill: true,
                        tension: 0.3
                      }]
                    }}
                    options={chartOptions}
                  />
                </div>
              </div>

              {/* Chart 2: STM32 Real-Time ECG */}
              <div className="flex-1 w-full bg-gray-50 rounded-lg border border-gray-100 relative p-3 flex flex-col justify-center items-center group">
                <div className="absolute top-3 left-4 flex items-center gap-2 text-[11px] font-medium text-gray-500 z-10">
                  <HeartPulse size={12} /> STM32 Real-Time ECG
                </div>
                <div className="flex flex-col items-center justify-center text-gray-300">
                  <Wifi size={18} className="mb-1.5" />
                  <span className="text-[11px] font-medium">Waiting for stream...</span>
                </div>
                <div className="w-full flex-1 opacity-15 pointer-events-none mt-3">
                  <Line
                    data={{ labels, datasets: [{ data: Array(1000).fill(0), borderColor: '#94a3b8', borderWidth: 1, borderDash: [3, 5] }] }}
                    options={chartOptions}
                  />
                </div>
              </div>

              {/* Chart 3: STM32 Real-Time PCG */}
              <div className="flex-1 w-full bg-gray-50 rounded-lg border border-gray-100 relative p-3 flex flex-col justify-center items-center group">
                <div className="absolute top-3 left-4 flex items-center gap-2 text-[11px] font-medium text-gray-500 z-10">
                  <Stethoscope size={12} /> STM32 Real-Time PCG
                </div>
                <div className="flex flex-col items-center justify-center text-gray-300">
                  <Wifi size={18} className="mb-1.5" />
                  <span className="text-[11px] font-medium">Waiting for stream...</span>
                </div>
                <div className="w-full flex-1 opacity-15 pointer-events-none mt-3">
                  <Line
                    data={{ labels, datasets: [{ data: Array(1000).fill(0), borderColor: '#94a3b8', borderWidth: 1, borderDash: [3, 5] }] }}
                    options={chartOptions}
                  />
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* Right Panel — Correlation */}
        <div className="xl:col-span-3 flex flex-col gap-6">
          <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm flex-1 flex flex-col">
            <h3 className="text-xs font-semibold text-gray-500 tracking-wide mb-5 text-center uppercase">Stroke Risk Correlation</h3>

            {/* Score */}
            <div className="flex flex-col items-center justify-center py-6 px-4 bg-gray-50 border border-gray-100 rounded-xl mb-6">
              <div className="text-5xl font-bold text-gray-800 mb-1">
                {simLabel}<span className="text-xl text-gray-400 ml-0.5">%</span>
              </div>
              <div className="text-[10px] font-medium text-gray-400 tracking-widest mb-3 uppercase">Similarity</div>
              <div className="text-[11px] font-semibold text-green-700 bg-green-50 px-4 py-1.5 rounded-full border border-green-200 uppercase tracking-wider">
                Low Risk
              </div>
            </div>

            {/* Correlation History */}
            <div className="flex-1 flex flex-col justify-end gap-5">
              <div>
                <h4 className="text-[10px] font-semibold text-gray-400 tracking-wider mb-2 uppercase">Correlation History</h4>
                <div className="h-[80px] w-full">
                  <Bar
                    data={{
                      labels: ['1', '2', '3', '4', '5', '6', '7', '8'],
                      datasets: [{
                        data: simHistory,
                        backgroundColor: ['#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#e2e8f0','#3b82f6'],
                        borderRadius: 4
                      }]
                    }}
                    options={{
                      ...chartOptions,
                      scales: { x: { display: false }, y: { display: false } }
                    }}
                  />
                </div>
              </div>

              {/* Compared Signal */}
              <div>
                <h4 className="text-[10px] font-semibold text-gray-400 tracking-wider mb-2 uppercase">Compared Signal (Realtime vs. Data)</h4>
                <div className="h-[80px] w-full bg-gray-50 rounded-lg p-2 border border-gray-100 relative">
                  <Line
                    data={{
                      labels: labels.slice(0, 80),
                      datasets: [
                        { data: sweepBuffer.slice(0, 80), borderColor: '#3b82f6', borderWidth: 1.5 },
                        { data: [], borderColor: '#d1d5db', borderWidth: 1, borderDash: [4, 4] }
                      ]
                    }}
                    options={{
                      ...chartOptions,
                      scales: { x: { display: false }, y: { display: false } }
                    }}
                  />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-red-300"></div>
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </main>
  );
}
