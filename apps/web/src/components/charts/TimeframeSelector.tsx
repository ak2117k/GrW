import { useChartStore } from '@/stores/chart-store';
import clsx from 'clsx';
import { CHART_TIMEFRAMES, CHART_TIMEFRAME_LABELS } from '@td/shared';

// Rendered from the shared roster, not a local list: the hand-maintained copy
// drifted from the S/R engine's supported set (offered 4H, which nothing can
// analyse; omitted 1M, which everything can).

export default function TimeframeSelector() {
  const timeframe = useChartStore((s) => s.timeframe);
  const setTimeframe = useChartStore((s) => s.setTimeframe);

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-[var(--color-bg-primary)] p-0.5">
      {CHART_TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => setTimeframe(tf)}
          className={clsx(
            'px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-150',
            timeframe === tf
              ? 'bg-[var(--color-accent-blue)] text-white shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]',
          )}
        >
          {CHART_TIMEFRAME_LABELS[tf]}
        </button>
      ))}
    </div>
  );
}
