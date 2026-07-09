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
const MAX_POINTS = 4000; // 4s window @ 1000 Hz — realistic ECG monitor sweep length
const labels = Array.from({ length: MAX_POINTS }, (_, i) => i);
const BACKEND = 'http://localhost:8087';
const WS_URL_STM32 = 'ws://localhost:8087/ws';
const WS_URL_HISTORICAL = 'ws://localhost:8080';
const COMMON_BAUDS = [9600, 38400, 115200, 230400];

// ─── Sample Rates ───
const SAMPLE_RATE_STM32 = 1000; // matches STM32 hardware (TIM2 @ 1000 Hz, see main.c)
const SAMPLE_RATE_HISTORICAL = 1000;
const SAMPLE_RATE_HEALTHY = 1000; // WFDB 103003_ECG, native 1000 Hz

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

const ECG_OPTIONS = buildChartOptions(-2500, 2500); // filtered ECG — wide range to match STM32 signal
const PCG_OPTIONS = buildChartOptions(-600, 600);   // filtered PCG (20–150 Hz)
const ECG_RAW_OPTIONS = buildChartOptions(0, 4095); // raw ADC 12-bit
const PCG_RAW_OPTIONS = buildChartOptions(0, 4095); // raw ADC 12-bit
const AUTO_OPTIONS = buildChartOptions(undefined, undefined); // auto-scale
const HISTORICAL_OPTIONS = buildChartOptions(-2500, 2500);
const HEALTHY_OPTIONS = buildChartOptions(undefined, undefined); // physical uV, auto-scaled (24h range unknown ahead of time)

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
    cov += dx * dy;
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
  if (riskPct <= 25) return { pct: riskPct, label: 'LOW RISK CORRELATION', color: '#16a34a' };
  if (riskPct <= 50) return { pct: riskPct, label: 'MODERATE RISK CORRELATION', color: '#ca8a04' };
  if (riskPct <= 75) return { pct: riskPct, label: 'HIGH RISK CORRELATION', color: '#ea580c' };
  return { pct: riskPct, label: 'VERY HIGH RISK', color: '#dc2626' };
}

// ─── FFT (Cooley-Tukey Radix-2) ───
function fftRadix2(re: number[], im: number[]): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Cooley-Tukey butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const tRe = curRe * re[i + k + halfLen] - curIm * im[i + k + halfLen];
        const tIm = curRe * im[i + k + halfLen] + curIm * re[i + k + halfLen];
        re[i + k + halfLen] = re[i + k] - tRe;
        im[i + k + halfLen] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

// Next power of 2
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface FFTResult {
  freqs: number[];
  magnitudes: number[];
  peakFreq: number;
  peakMag: number;
}

function computeFFTMagnitude(
  buffer: (number | null)[],
  sampleRate: number,
  maxFreq?: number
): FFTResult {
  const windowSamples = Math.min(sampleRate * 3, buffer.length);
  const signal: number[] = [];
  for (let i = buffer.length - windowSamples; i < buffer.length; i++) {
    signal.push(buffer[i] ?? 0);
  }
  const hasData = signal.some(v => v !== 0);
  if (!hasData) return { freqs: [], magnitudes: [], peakFreq: 0, peakMag: 0 };

  // Remove DC offset
  let sum = 0;
  for (const v of signal) sum += v;
  const mean = sum / signal.length;
  for (let i = 0; i < signal.length; i++) signal[i] -= mean;

  // Hanning window
  const N = signal.length;
  for (let i = 0; i < N; i++) {
    signal[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }

  // Zero-pad to next power of 2
  const nfft = nextPow2(N);
  const re = new Array(nfft).fill(0);
  const im = new Array(nfft).fill(0);
  for (let i = 0; i < N; i++) re[i] = signal[i];

  fftRadix2(re, im);

  const halfN = nfft >> 1;
  const freqResolution = sampleRate / nfft;
  // Cap at nfft-1 (not halfN) so maxFreq beyond Nyquist naturally reveals the
  // conjugate-symmetric mirror of a real-valued signal's spectrum, instead of
  // being clipped at the Nyquist bin.
  const cutoffBin = maxFreq ? Math.min(Math.floor(maxFreq / freqResolution), nfft - 1) : halfN;

  const freqs: number[] = [];
  const magnitudes: number[] = [];
  let peakFreq = 0, peakMag = 0;

  for (let i = 1; i <= cutoffBin; i++) {
    const freq = i * freqResolution;
    const mag = (2 / N) * Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    freqs.push(Math.round(freq * 10) / 10);
    magnitudes.push(Math.round(mag * 100) / 100);
    if (mag > peakMag) { peakMag = mag; peakFreq = freq; }
  }

  return {
    freqs,
    magnitudes,
    peakFreq: Math.round(peakFreq * 10) / 10,
    peakMag: Math.round(peakMag * 100) / 100
  };
}

// ─── Stroke vs Healthy Deviation Frequencies ───
interface DeviationFreq {
  freq: number;
  strokeMag: number;
  healthyMag: number;
  delta: number;
}

// Finds the top-N frequency bins where the stroke-reference and healthy-reference
// spectra diverge the most. These become the "watch list" frequencies used to
// screen the live ECG/PCG signals for a stroke-like pattern.
function computeDeviationFrequencies(strokeFFT: FFTResult, healthyFFT: FFTResult, topN: number): DeviationFreq[] {
  const len = Math.min(strokeFFT.freqs.length, healthyFFT.freqs.length);
  if (len === 0) return [];

  const diffs: DeviationFreq[] = [];
  for (let i = 0; i < len; i++) {
    const strokeMag = strokeFFT.magnitudes[i];
    const healthyMag = healthyFFT.magnitudes[i];
    diffs.push({ freq: strokeFFT.freqs[i], strokeMag, healthyMag, delta: Math.abs(strokeMag - healthyMag) });
  }
  diffs.sort((a, b) => b.delta - a.delta);
  return diffs.slice(0, topN);
}

// Nearest-bin magnitude lookup; returns null if the target frequency is beyond
// what this FFT result covers (e.g. PCG FFT is capped at 500 Hz).
function findMagnitudeAtFreq(fft: FFTResult, targetFreq: number): number | null {
  if (fft.freqs.length === 0) return null;
  if (targetFreq > fft.freqs[fft.freqs.length - 1]) return null;
  let closestIdx = 0, closestDiff = Infinity;
  for (let i = 0; i < fft.freqs.length; i++) {
    const d = Math.abs(fft.freqs[i] - targetFreq);
    if (d < closestDiff) { closestDiff = d; closestIdx = i; }
  }
  return fft.magnitudes[closestIdx];
}

interface DeviationCheck extends DeviationFreq {
  ecgMag: number | null;
  pcgMag: number | null;
  ecgHit: boolean;
  pcgHit: boolean;
}

interface StrokeDetectionResult {
  checks: DeviationCheck[];
  hitCount: number;
  abnormal: boolean;
}

// At each watch-list frequency, flags a "hit" when the live signal (ECG or PCG)
// sits closer to the stroke-reference magnitude than to the healthy-reference
// magnitude — i.e. the live spectrum looks more like the stroke pattern than the
// healthy one at that specific frequency. Any hit triggers an abnormal flag.
function detectStrokeIndication(
  deviationFreqs: DeviationFreq[],
  ecgFFT: FFTResult,
  pcgFFT: FFTResult
): StrokeDetectionResult {
  const checks: DeviationCheck[] = deviationFreqs.map(dev => {
    const ecgMag = findMagnitudeAtFreq(ecgFFT, dev.freq);
    const pcgMag = findMagnitudeAtFreq(pcgFFT, dev.freq);
    const closerToStroke = (liveMag: number | null) =>
      liveMag !== null && Math.abs(liveMag - dev.strokeMag) < Math.abs(liveMag - dev.healthyMag);
    const ecgHit = closerToStroke(ecgMag);
    const pcgHit = closerToStroke(pcgMag);
    return { ...dev, ecgMag, pcgMag, ecgHit, pcgHit };
  });
  const hitCount = checks.filter(c => c.ecgHit || c.pcgHit).length;
  return { checks, hitCount, abnormal: hitCount > 0 };
}

// ─── FFT Chart Options Builder ───
const buildFFTChartOptions = (accentColor: string, maxFreq: number): ChartOptions<'line'> => ({
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0.2 } },
  scales: {
    x: {
      display: true,
      type: 'linear',
      min: 0,
      max: maxFreq,
      grid: { color: `${accentColor}15`, lineWidth: 0.4 },
      ticks: {
        color: accentColor,
        font: { size: 9, weight: 600 },
        maxTicksLimit: 3,
        callback: (v: any) => `${v}`,
      },
      // Force exactly 3 ticks: 0, midpoint, max — regardless of zoom or data range
      afterBuildTicks: (axis: any) => {
        axis.ticks = [
          { value: 0 },
          { value: Math.round(maxFreq / 2) },
          { value: maxFreq },
        ];
      },
      title: { display: true, text: 'Frequency (Hz)', color: accentColor, font: { size: 9, weight: 'bold' as const } }
    },
    y: {
      display: true,
      grid: { color: `${accentColor}15`, lineWidth: 0.4 },
      ticks: { color: accentColor, font: { size: 9, weight: 600 }, maxTicksLimit: 5 },
      title: { display: true, text: 'Magnitude', color: accentColor, font: { size: 9, weight: 'bold' as const } }
    }
  },
  plugins: { legend: { display: false }, tooltip: { enabled: false } }
});

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

// ─── FFT Chart Card ───
const FFTChartCard = ({ title, subtitle, fftData, accentColor, bgColor, borderColor, chartOptions, waiting = false, className = '' }: {
  title: string;
  subtitle: string;
  fftData: FFTResult;
  accentColor: string;
  bgColor: string;
  borderColor: string;
  chartOptions: ChartOptions<'line'>;
  waiting?: boolean;
  className?: string;
}) => {
  const hasData = fftData.freqs.length > 0;
  return (
    <div className={`rounded-2xl px-5 pt-5 pb-4 flex flex-col relative ${className}`}
      style={{ backgroundColor: bgColor, border: `1px solid ${borderColor}` }}>
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="text-[13px] font-bold m-0 uppercase tracking-wider" style={{ color: accentColor }}>{title}</h3>
          <p className="text-[10px] font-semibold mt-[3px]" style={{ color: `${accentColor}99` }}>{subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          {hasData && (
            <div className="flex gap-3 text-[9px] font-bold tracking-wider" style={{ color: accentColor }}>
              <span>PEAK <span style={{ color: accentColor }}>{fftData.peakFreq} Hz</span></span>
              <span>MAG <span style={{ color: accentColor }}>{fftData.peakMag.toFixed(0)}</span></span>
            </div>
          )}
          <div className="flex items-center gap-[5px] text-[10px] font-bold tracking-[0.1em]" style={{ color: accentColor }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            FFT
          </div>
        </div>
      </div>
      <div className="flex-1 relative w-full min-h-0">
        {waiting || !hasData ? (
          <div className="absolute inset-0 flex justify-center items-center">
            <span className="text-[12px] font-semibold" style={{ color: `${accentColor}60` }}>Waiting for data...</span>
          </div>
        ) : (
          <Line
            data={{
              labels: fftData.freqs,
              datasets: [{
                data: fftData.magnitudes.map((mag, i) => ({ x: fftData.freqs[i], y: mag })),
                borderColor: accentColor,
                backgroundColor: `${accentColor}20`,
                borderWidth: 1.5,
                tension: 0.3,
                pointRadius: 0,
                fill: true,
              }]
            }}
            options={chartOptions}
          />
        )}
      </div>
    </div>
  );
};


export default function Dashboard() {
  const [setupDone, setSetupDone] = useState(false);
  const [ports, setPorts] = useState<{ port: string, description: string }[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [selectedBaud, setSelectedBaud] = useState(115200);
  const [portsLoading, setPortsLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Data States
  const [, setConnectedHistorical] = useState(false);
  const [connectedSTM32, setConnectedSTM32] = useState(false);
  const [historicalBuffer, setHistoricalBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [healthyBuffer, setHealthyBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [stm32Buffer, setStm32Buffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [pcgBuffer, setPcgBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [stm32RawBuffer, setStm32RawBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [pcgRawBuffer, setPcgRawBuffer] = useState<(number | null)[]>(Array(MAX_POINTS).fill(null));
  const [useRaw, setUseRaw] = useState(false);
  const [autoScale, setAutoScale] = useState(false);

  // ─── FFT Computation (Sliding Window 3s) ───
  const historicalFFT = useMemo(
    () => computeFFTMagnitude(historicalBuffer, SAMPLE_RATE_HISTORICAL, 1000),
    [historicalBuffer]
  );
  const ecgFFT = useMemo(
    () => computeFFTMagnitude(useRaw ? stm32RawBuffer : stm32Buffer, SAMPLE_RATE_STM32, 1000),
    [useRaw, stm32RawBuffer, stm32Buffer]
  );
  const pcgFFT = useMemo(
    () => computeFFTMagnitude(useRaw ? pcgRawBuffer : pcgBuffer, SAMPLE_RATE_STM32, 500),
    [useRaw, pcgRawBuffer, pcgBuffer]
  );
  const healthyFFT = useMemo(
    () => computeFFTMagnitude(healthyBuffer, SAMPLE_RATE_HEALTHY, 1000),
    [healthyBuffer]
  );

  // ─── Pearson Correlation (FFT Historical ↔ FFT PCG) ───
  const pearsonR = useMemo(() => {
    const hMag = historicalFFT.magnitudes;
    const pMag = pcgFFT.magnitudes;
    if (hMag.length === 0 || pMag.length === 0) return NaN;
    const len = Math.min(hMag.length, pMag.length);
    return pearsonCorrelation(hMag.slice(0, len), pMag.slice(0, len));
  }, [historicalFFT, pcgFFT]);
  const risk = useMemo(() => riskFromCorrelation(pearsonR), [pearsonR]);

  // ─── Pearson Correlation (FFT Stroke-Ref ↔ FFT Healthy-Ref) ───
  const strokeHealthyR = useMemo(() => {
    const sMag = historicalFFT.magnitudes;
    const hMag = healthyFFT.magnitudes;
    if (sMag.length === 0 || hMag.length === 0) return NaN;
    const len = Math.min(sMag.length, hMag.length);
    return pearsonCorrelation(sMag.slice(0, len), hMag.slice(0, len));
  }, [historicalFFT, healthyFFT]);

  // ─── Deviation frequencies (stroke-ref vs healthy-ref) + live detection ───
  const deviationFreqs = useMemo(
    () => computeDeviationFrequencies(historicalFFT, healthyFFT, 5),
    [historicalFFT, healthyFFT]
  );
  const strokeDetection = useMemo(
    () => detectStrokeIndication(deviationFreqs, ecgFFT, pcgFFT),
    [deviationFreqs, ecgFFT, pcgFFT]
  );

  // FFT chart options (memoized)
  const historicalFFTOptions = useMemo(() => buildFFTChartOptions('#db2777', 1000), []);
  const ecgFFTOptions = useMemo(() => buildFFTChartOptions('#db2777', 1000), []);
  const pcgFFTOptions = useMemo(() => buildFFTChartOptions('#db2777', 500), []);
  const healthyFFTOptions = useMemo(() => buildFFTChartOptions('#db2777', 1000), []);

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
    let healthyBuf = Array(MAX_POINTS).fill(null);
    let healthyIdx = 0;
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
      if (payload.healthy_ecg) {
        payload.healthy_ecg.forEach((val: number) => {
          healthyBuf[healthyIdx] = val;
          healthyIdx = (healthyIdx + 1) % MAX_POINTS;
        });
        setHealthyBuffer([...healthyBuf]);
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
                    {b >= 1000 ? `${b / 1000}K` : b}
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

      {/* ─── Row 1: Historical Reference ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard
          title="Historical Reference"
          subtitle="Baseline Signal Pattern · Time Domain"
          data={historicalBuffer}
          options={HISTORICAL_OPTIONS}
          className="h-[300px]"
        />
        <FFTChartCard
          title="Historical FFT"
          subtitle="Frequency Spectrum · Window 3s · 0–1000 Hz"
          fftData={historicalFFT}
          accentColor="#db2777"
          bgColor="#fff0f5"
          borderColor="#fbcfe8"
          chartOptions={historicalFFTOptions}
          className="h-[300px]"
        />
      </div>

      {/* ─── Row 1b: Healthy 24h Reference ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard
          title="Healthy Subject Reference (24h)"
          subtitle="WFDB 103003_ECG · 1000 Hz · Physical Units (uV)"
          live
          data={healthyBuffer}
          options={HEALTHY_OPTIONS}
          className="h-[300px]"
        />
        <FFTChartCard
          title="Healthy FFT"
          subtitle="Frequency Spectrum · Window 3s · 0–1000 Hz"
          fftData={healthyFFT}
          accentColor="#db2777"
          bgColor="#fff0f5"
          borderColor="#fbcfe8"
          chartOptions={healthyFFTOptions}
          className="h-[300px]"
        />
      </div>

      {/* ─── Row 2: STM32 ECG ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard
          title="STM32 Real-time ECG"
          subtitle={useRaw ? "Raw ADC · Time Domain" : "Electrocardiogram · Time Domain"}
          live
          data={useRaw ? stm32RawBuffer : stm32Buffer}
          options={autoScale ? AUTO_OPTIONS : (useRaw ? ECG_RAW_OPTIONS : ECG_OPTIONS)}
          showStats
          waiting={!connectedSTM32}
          className="h-[300px]"
        />
        <FFTChartCard
          title="ECG FFT"
          subtitle={`Frequency Spectrum · Window 3s · 0–1000 Hz${useRaw ? ' · Raw' : ''}`}
          fftData={ecgFFT}
          accentColor="#db2777"
          bgColor="#fff0f5"
          borderColor="#fbcfe8"
          chartOptions={ecgFFTOptions}
          waiting={!connectedSTM32}
          className="h-[300px]"
        />
      </div>

      {/* ─── Row 3: STM32 PCG ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard
          title="STM32 Real-time PCG"
          subtitle={useRaw ? "Raw ADC · Time Domain" : "Phonocardiogram · Time Domain"}
          live
          data={useRaw ? pcgRawBuffer : pcgBuffer}
          options={autoScale ? AUTO_OPTIONS : (useRaw ? PCG_RAW_OPTIONS : PCG_OPTIONS)}
          showStats
          waiting={!connectedSTM32}
          className="h-[300px]"
        />
        <FFTChartCard
          title="PCG FFT"
          subtitle={`Frequency Spectrum · Window 3s · 0–500 Hz${useRaw ? ' · Raw' : ''}`}
          fftData={pcgFFT}
          accentColor="#db2777"
          bgColor="#fff0f5"
          borderColor="#fbcfe8"
          chartOptions={pcgFFTOptions}
          waiting={!connectedSTM32}
          className="h-[300px]"
        />
      </div>

      {/* ─── Row 4: Risk Correlation ─── */}
      <div className="bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl p-6 flex flex-col justify-between h-[280px]">
        <div>
          <p className="text-[12px] font-bold text-[#ec4899] uppercase tracking-wider">Stroke Risk Correlation</p>
          <p className="text-[10px] font-semibold text-[#be185d] mt-1">FFT Spectrum Correlation · Historical ↔ PCG</p>
          <div className="flex items-baseline gap-1 mt-4">
            <span className="text-[60px] font-black text-[#831843] leading-none">{risk.pct}</span>
            <span className="text-[26px] font-extrabold text-[#831843] leading-none">%</span>
            <span className="ml-3 text-[18px] font-bold text-[#831843]">{risk.label}</span>
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
          <div className="flex justify-between text-[10px] font-bold text-[#ec4899]">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
        </div>
      </div>

      {/* ─── Row 5: Frequency-Based Stroke Detection ─── */}
      <div className="bg-[#fff0f5] border border-[#fbcfe8] rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
          <div>
            <p className="text-[12px] font-bold text-[#ec4899] uppercase tracking-wider">Frequency-Based Stroke Detection</p>
            <p className="text-[10px] font-semibold text-[#be185d] mt-1">
              Stroke-Ref ↔ Healthy-Ref Similarity · Pearson r = {isNaN(strokeHealthyR) ? '—' : strokeHealthyR.toFixed(4)}
            </p>
            <p className="text-[10px] font-semibold text-[#be185d] mt-1">
              Watch-list: top {deviationFreqs.length} frequencies where stroke-ref and healthy-ref spectra diverge most
            </p>
          </div>
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-xl border shrink-0"
            style={{
              color: strokeDetection.abnormal ? '#dc2626' : '#16a34a',
              backgroundColor: strokeDetection.abnormal ? '#fef2f2' : '#f0fdf4',
              borderColor: strokeDetection.abnormal ? '#fecaca' : '#bbf7d0',
            }}
          >
            <AlertCircle size={18} />
            <span className="text-[14px] font-black uppercase tracking-wider">
              {strokeDetection.abnormal ? 'Indikasi Stroke (Abnormal)' : 'Normal'}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[#be185d] uppercase tracking-wider">
                <th className="py-1.5 pr-4 font-bold">Freq (Hz)</th>
                <th className="py-1.5 pr-4 font-bold">Stroke-Ref Mag</th>
                <th className="py-1.5 pr-4 font-bold">Healthy-Ref Mag</th>
                <th className="py-1.5 pr-4 font-bold">Δ</th>
                <th className="py-1.5 pr-4 font-bold">ECG Live</th>
                <th className="py-1.5 pr-4 font-bold">PCG Live</th>
                <th className="py-1.5 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {strokeDetection.checks.length === 0 ? (
                <tr><td colSpan={7} className="py-3 text-[#f9a8d4] font-semibold">Waiting for reference data...</td></tr>
              ) : strokeDetection.checks.map((c, idx) => {
                const hit = c.ecgHit || c.pcgHit;
                return (
                  <tr key={idx} className="border-t border-[#fbcfe8] text-[#831843]">
                    <td className="py-1.5 pr-4 font-bold">{c.freq.toFixed(1)}</td>
                    <td className="py-1.5 pr-4">{c.strokeMag.toFixed(2)}</td>
                    <td className="py-1.5 pr-4">{c.healthyMag.toFixed(2)}</td>
                    <td className="py-1.5 pr-4">{c.delta.toFixed(2)}</td>
                    <td className={`py-1.5 pr-4 ${c.ecgHit ? 'font-bold text-[#dc2626]' : ''}`}>{c.ecgMag !== null ? c.ecgMag.toFixed(2) : '—'}</td>
                    <td className={`py-1.5 pr-4 ${c.pcgHit ? 'font-bold text-[#dc2626]' : ''}`}>{c.pcgMag !== null ? c.pcgMag.toFixed(2) : '—'}</td>
                    <td className="py-1.5">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${hit ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
                        {hit ? 'ABNORMAL' : 'NORMAL'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}