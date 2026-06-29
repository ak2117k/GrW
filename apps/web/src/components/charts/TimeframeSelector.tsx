import { useChartStore } from '@/stores/chart-store';
import clsx from 'clsx';

const TIMEFRAMES = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
  { label: '1W', value: '1w' },
];

export default function TimeframeSelector() {
  const timeframe = useChartStore((s) => s.timeframe);
  const setTimeframe = useChartStore((s) => s.setTimeframe);

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-[var(--color-bg-primary)] p-0.5">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.value}
          onClick={() => setTimeframe(tf.value)}
          className={clsx(
            'px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-150',
            timeframe === tf.value
              ? 'bg-[var(--color-accent-blue)] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]',
          )}
        >
          {tf.label}
        </button>
      ))}
    </div>
  );
}
