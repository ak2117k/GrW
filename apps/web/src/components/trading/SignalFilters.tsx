import { cn } from '@/utils/cn';
import { Toggle } from '@/components/common';
import type { SignalFilters as FilterType } from '@/stores/signal-store';

interface SignalFiltersProps {
  filters: FilterType;
  onFilterChange: (partial: Partial<FilterType>) => void;
  className?: string;
}

const selectClass =
  'rounded-md border border-gray-700 bg-gray-800/80 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none';

export default function SignalFilters({
  filters,
  onFilterChange,
  className,
}: SignalFiltersProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-gray-700/60 bg-gray-800/40 px-4 py-2.5',
        className,
      )}
    >
      {/* Strategy */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Strategy
        </label>
        <select
          className={selectClass}
          value={filters.strategy}
          onChange={(e) => onFilterChange({ strategy: e.target.value })}
        >
          <option value="all">All</option>
          <option value="rsi-reversal">RSI Reversal</option>
          <option value="ema-crossover">EMA Crossover</option>
          <option value="vwap-deviation">VWAP Deviation</option>
        </select>
      </div>

      {/* Segment */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Segment
        </label>
        <select
          className={selectClass}
          value={filters.segment}
          onChange={(e) => onFilterChange({ segment: e.target.value })}
        >
          <option value="all">All</option>
          <option value="OPTIONS">Options</option>
          <option value="EQUITY">Equity</option>
          <option value="FUTURES">Futures</option>
          <option value="COMMODITY">Commodity</option>
        </select>
      </div>

      {/* Confidence */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Min Confidence
        </label>
        <select
          className={selectClass}
          value={filters.minConfidence}
          onChange={(e) => onFilterChange({ minConfidence: e.target.value })}
        >
          <option value="all">All</option>
          <option value="LOW">Low+</option>
          <option value="MEDIUM">Medium+</option>
          <option value="HIGH">High+</option>
          <option value="VERY_HIGH">Very High</option>
        </select>
      </div>

      {/* Active toggle */}
      <div className="flex items-center gap-1.5">
        <Toggle
          checked={filters.isActive}
          onChange={(checked) => onFilterChange({ isActive: checked })}
          label="Active only"
          size="sm"
        />
      </div>

      {/* Today-only toggle — defaults on so the page doesn't accumulate
          weeks of signals if a legacy row slips past the backend sweep. */}
      <div className="flex items-center gap-1.5">
        <Toggle
          checked={filters.todayOnly}
          onChange={(checked) => onFilterChange({ todayOnly: checked })}
          label="Today only"
          size="sm"
        />
      </div>

      {/* Sort */}
      <div className="ml-auto flex items-center gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Sort
        </label>
        <select
          className={selectClass}
          value={filters.sortBy}
          onChange={(e) =>
            onFilterChange({
              sortBy: e.target.value as FilterType['sortBy'],
            })
          }
        >
          <option value="confidence">Confidence</option>
          <option value="time">Time</option>
          <option value="riskReward">Risk/Reward</option>
        </select>
      </div>
    </div>
  );
}
