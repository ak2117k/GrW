import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useChartStore, type IndicatorState } from '@/stores/chart-store';
import { computeSessionVWAP } from '@/utils/computeVWAP';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface IndicatorConfig {
  key: keyof IndicatorState;
  label: string;
  description: string;
  color: string;
  ready: boolean;
}

const INDICATORS: IndicatorConfig[] = [
  { key: 'ema20', label: 'EMA 20', description: 'Exponential MA (20)', color: '#3b82f6', ready: true },
  { key: 'ema50', label: 'EMA 50', description: 'Exponential MA (50)', color: '#a855f7', ready: true },
  { key: 'ema200', label: 'EMA 200', description: 'Exponential MA (200)', color: '#f59e0b', ready: true },
  { key: 'vwap', label: 'VWAP', description: 'Session VWAP (resets 9:15 IST daily)', color: '#10b981', ready: true },
  { key: 'bollinger', label: 'Bollinger', description: 'Bollinger Bands (20, 2σ)', color: '#ec4899', ready: true },
  { key: 'rsi', label: 'RSI', description: 'Relative Strength Index (14)', color: '#06b6d4', ready: true },
  { key: 'volume', label: 'Volume', description: 'Volume histogram', color: '#64748b', ready: true },
  { key: 'oi', label: 'OI', description: 'Open Interest overlay', color: '#fbbf24', ready: true },
];

interface IndicatorPanelProps {
  onClose: () => void;
  chart: IChartApi | null;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

// Calculate EMA
function calculateEMA(closes: number[], period: number): (number | null)[] {
  const ema: (number | null)[] = [];
  if (closes.length < period) {
    return closes.map(() => null);
  }

  const k = 2 / (period + 1);

  // Start with SMA for the first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
    ema.push(null);
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    const prev = ema[i - 1] as number;
    ema.push(closes[i] * k + prev * (1 - k));
  }

  return ema;
}

// Wilder's RSI (period 14 by default).
function calculateRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gainSum += ch;
    else lossSum -= ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Bollinger Bands — SMA ± stdDevMult * stddev over `period` closes.
function calculateBollinger(
  closes: number[],
  period = 20,
  stdDevMult = 2,
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const middle: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;

    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (closes[j] - mean) ** 2;
    const std = Math.sqrt(varSum / period);

    middle[i] = mean;
    upper[i] = mean + stdDevMult * std;
    lower[i] = mean - stdDevMult * std;
  }

  return { upper, middle, lower };
}

export default function IndicatorPanel({ onClose, chart, candles }: IndicatorPanelProps) {
  const indicators = useChartStore((s) => s.indicators);
  const toggleIndicator = useChartStore((s) => s.toggleIndicator);
  const emaSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  const handleToggle = (indicator: IndicatorConfig) => {
    if (!indicator.ready) {
      toast('Coming soon! This indicator is under development.', {
        icon: '🔧',
        style: {
          background: '#1a1a2e',
          color: '#f1f5f9',
          border: '1px solid #334155',
        },
      });
      return;
    }
    toggleIndicator(indicator.key);
  };

  // Manage all line-series indicators on the chart.
  // Each spec is a single line; Bollinger registers as 3 specs (upper/middle/lower).
  // RSI uses its own price scale so it doesn't fight the price-axis range.
  useEffect(() => {
    if (!chart || candles.length === 0) return;

    const closes = candles.map((c) => c.close);
    const bb = calculateBollinger(closes, 20, 2);
    const rsiValues = calculateRSI(closes, 14);
    const vwapValues = computeSessionVWAP(candles);

    type LineSpec = {
      mapKey: string;
      enabled: boolean;
      color: string;
      lineWidth?: 1 | 2 | 3 | 4;
      lineStyle?: number;
      priceScaleId?: string;
      values: (number | null)[];
    };

    const specs: LineSpec[] = [
      // Price-scale overlays (share the main candle scale)
      { mapKey: 'ema20', enabled: indicators.ema20, color: '#3b82f6', values: calculateEMA(closes, 20) },
      { mapKey: 'ema50', enabled: indicators.ema50, color: '#a855f7', values: calculateEMA(closes, 50) },
      { mapKey: 'ema200', enabled: indicators.ema200, color: '#f59e0b', values: calculateEMA(closes, 200) },
      { mapKey: 'vwap', enabled: indicators.vwap, color: '#10b981', lineWidth: 2, values: vwapValues },
      { mapKey: 'bb-upper', enabled: indicators.bollinger, color: '#ec4899', lineWidth: 1, values: bb.upper },
      { mapKey: 'bb-middle', enabled: indicators.bollinger, color: '#ec4899', lineWidth: 1, lineStyle: 2, values: bb.middle },
      { mapKey: 'bb-lower', enabled: indicators.bollinger, color: '#ec4899', lineWidth: 1, values: bb.lower },
      // RSI lives on its own price scale (0–100) so it doesn't crush the candle axis.
      { mapKey: 'rsi', enabled: indicators.rsi, color: '#06b6d4', lineWidth: 1, priceScaleId: 'rsi', values: rsiValues },
    ];

    for (const spec of specs) {
      const existing = emaSeriesRef.current.get(spec.mapKey);
      const lineData = candles
        .map((c, i) =>
          spec.values[i] !== null
            ? { time: Math.floor(c.time) as Time, value: spec.values[i] as number }
            : null,
        )
        .filter(Boolean) as Array<{ time: Time; value: number }>;

      if (spec.enabled && !existing) {
        const series = chart.addLineSeries({
          color: spec.color,
          lineWidth: spec.lineWidth ?? 1,
          lineStyle: spec.lineStyle ?? 0,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...(spec.priceScaleId ? { priceScaleId: spec.priceScaleId } : {}),
        });
        // Configure dedicated RSI scale once when its first series appears.
        if (spec.priceScaleId === 'rsi') {
          chart.priceScale('rsi').applyOptions({
            scaleMargins: { top: 0.7, bottom: 0.05 },
            borderVisible: false,
          });
        }
        series.setData(lineData);
        emaSeriesRef.current.set(spec.mapKey, series);
      } else if (spec.enabled && existing) {
        existing.setData(lineData);
      } else if (!spec.enabled && existing) {
        try {
          chart.removeSeries(existing);
        } catch {
          // Chart may be disposed
        }
        emaSeriesRef.current.delete(spec.mapKey);
      }
    }
  }, [chart, candles, indicators]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!chart) return;
      for (const [, series] of emaSeriesRef.current) {
        try {
          chart.removeSeries(series);
        } catch {
          // ignore
        }
      }
      emaSeriesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute top-0 right-0 w-64 bg-[var(--color-bg-secondary)] border-l border-[var(--color-border-subtle)] z-40 h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Indicators</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-3 space-y-1">
        {INDICATORS.map((indicator) => {
          const active = indicators[indicator.key];
          return (
            <button
              key={indicator.key}
              onClick={() => handleToggle(indicator)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                active
                  ? 'bg-[var(--color-bg-tertiary)]'
                  : 'hover:bg-[var(--color-bg-tertiary)]',
              )}
            >
              <div
                className={clsx(
                  'w-2.5 h-2.5 rounded-full shrink-0 transition-opacity',
                  active ? 'opacity-100' : 'opacity-30',
                )}
                style={{ backgroundColor: indicator.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'text-xs font-medium',
                      active
                        ? 'text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    {indicator.label}
                  </span>
                  {!indicator.ready && (
                    <span className="text-[9px] px-1 py-px rounded bg-[var(--color-bg-primary)] text-[var(--color-text-muted)]">
                      SOON
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--color-text-muted)] truncate">
                  {indicator.description}
                </p>
              </div>
              <div
                className={clsx(
                  'w-8 h-4 rounded-full flex items-center transition-colors px-0.5',
                  active ? 'bg-[var(--color-accent-blue)] justify-end' : 'bg-[var(--color-border-default)] justify-start',
                )}
              >
                <div className="w-3 h-3 rounded-full bg-white shadow-sm" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
