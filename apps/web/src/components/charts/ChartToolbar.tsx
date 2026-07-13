import {
  Maximize2,
  Minimize2,
  CandlestickChart as CandlestickIcon,
  LineChart,
  AreaChart,
  Activity,
  Shapes,
} from 'lucide-react';
import { useChartStore } from '@/stores/chart-store';
import SymbolSearch from './SymbolSearch';
import TimeframeSelector from './TimeframeSelector';
import clsx from 'clsx';

interface ChartToolbarProps {
  currentPrice: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  onToggleIndicators: () => void;
  showIndicatorPanel: boolean;
  onTogglePatterns: () => void;
  showPatterns: boolean;
}

export default function ChartToolbar({
  currentPrice,
  priceChange,
  priceChangePercent,
  onToggleIndicators,
  showIndicatorPanel,
  onTogglePatterns,
  showPatterns,
}: ChartToolbarProps) {
  const isFullscreen = useChartStore((s) => s.isFullscreen);
  const toggleFullscreen = useChartStore((s) => s.toggleFullscreen);
  const chartType = useChartStore((s) => s.chartType);
  const setChartType = useChartStore((s) => s.setChartType);
  const isUp = (priceChange ?? 0) >= 0;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      {/* Left section: Symbol + Price */}
      <div className="flex items-center gap-4">
        <SymbolSearch />

        {currentPrice !== null && (
          <div className="flex items-center gap-3">
            <span className={clsx('text-lg font-bold tabular-nums', isUp ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]')}>
              {currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span
              className={clsx(
                'text-xs font-medium px-1.5 py-0.5 rounded tabular-nums',
                isUp
                  ? 'text-[var(--color-accent-green)] bg-[rgba(0,207,132,0.1)]'
                  : 'text-[var(--color-accent-red)] bg-[rgba(239,68,68,0.1)]',
              )}
            >
              {isUp ? '+' : ''}
              {priceChange?.toFixed(2)} ({isUp ? '+' : ''}
              {priceChangePercent?.toFixed(2)}%)
            </span>
          </div>
        )}
      </div>

      {/* Center: Timeframe */}
      <TimeframeSelector />

      {/* Right section: Chart type, Indicators, Fullscreen */}
      <div className="flex items-center gap-1">
        {/* Chart type switcher */}
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--color-bg-primary)] p-0.5 mr-2">
          <button
            onClick={() => setChartType('candlestick')}
            title="Candlestick"
            className={clsx(
              'p-1.5 rounded-md transition-colors',
              chartType === 'candlestick'
                ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            <CandlestickIcon size={14} />
          </button>
          <button
            onClick={() => setChartType('line')}
            title="Line"
            className={clsx(
              'p-1.5 rounded-md transition-colors',
              chartType === 'line'
                ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            <LineChart size={14} />
          </button>
          <button
            onClick={() => setChartType('area')}
            title="Area"
            className={clsx(
              'p-1.5 rounded-md transition-colors',
              chartType === 'area'
                ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            <AreaChart size={14} />
          </button>
        </div>

        {/* Indicators toggle */}
        <button
          onClick={onToggleIndicators}
          title="Indicators"
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
            showIndicatorPanel
              ? 'bg-[var(--color-accent-blue)] text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]',
          )}
        >
          <Activity size={13} />
          <span>Indicators</span>
        </button>

        {/* Patterns toggle */}
        <button
          onClick={onTogglePatterns}
          title="Chart patterns"
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
            showPatterns
              ? 'bg-[var(--color-accent-blue)] text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]',
          )}
        >
          <Shapes size={13} />
          <span>Patterns</span>
        </button>

        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
    </div>
  );
}
