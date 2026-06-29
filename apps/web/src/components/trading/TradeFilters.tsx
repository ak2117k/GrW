import { Filter } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { JournalFilters } from '@/hooks/useTradeJournal';

interface TradeFiltersProps {
  filters: JournalFilters;
  onFilterChange: (partial: Partial<JournalFilters>) => void;
  strategies?: string[];
  className?: string;
}

const selectClass =
  'rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40';

const inputClass =
  'rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40';

export default function TradeFilters({
  filters,
  onFilterChange,
  strategies = [],
  className,
}: TradeFiltersProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-gray-700/60 bg-gray-800/50 px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-gray-400">
        <Filter size={14} />
        <span className="text-xs font-medium uppercase tracking-wide">Filters</span>
      </div>

      {/* Date Range */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-gray-500 uppercase">From</label>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => onFilterChange({ dateFrom: e.target.value })}
          className={inputClass}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-gray-500 uppercase">To</label>
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => onFilterChange({ dateTo: e.target.value })}
          className={inputClass}
        />
      </div>

      {/* Status */}
      <select
        value={filters.status}
        onChange={(e) => onFilterChange({ status: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Status</option>
        <option value="OPEN">Open</option>
        <option value="CLOSED">Closed</option>
        <option value="CANCELLED">Cancelled</option>
        <option value="REJECTED">Rejected</option>
      </select>

      {/* Strategy */}
      <select
        value={filters.strategy}
        onChange={(e) => onFilterChange({ strategy: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Strategies</option>
        {strategies.map((s) => (
          <option key={s} value={s}>
            {s
              .split('-')
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ')}
          </option>
        ))}
      </select>

      {/* Segment */}
      <select
        value={filters.segment}
        onChange={(e) => onFilterChange({ segment: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Segments</option>
        <option value="OPTIONS">Options</option>
        <option value="EQUITY">Equity</option>
        <option value="FUTURES">Futures</option>
        <option value="COMMODITY">Commodity</option>
      </select>

      {/* Paper/Live */}
      <select
        value={filters.paperLive}
        onChange={(e) => onFilterChange({ paperLive: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Types</option>
        <option value="paper">Paper Only</option>
        <option value="live">Live Only</option>
      </select>

      {/* M5: VIX regime at entry */}
      <select
        value={filters.vixRegime}
        onChange={(e) => onFilterChange({ vixRegime: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Regimes</option>
        <option value="LOW">Low VIX</option>
        <option value="NORMAL">Normal</option>
        <option value="ELEVATED">Elevated</option>
        <option value="HIGH">High VIX</option>
        <option value="UNKNOWN">Unknown</option>
      </select>

      {/* M5: structured exit reason */}
      <select
        value={filters.exitReasonTag}
        onChange={(e) => onFilterChange({ exitReasonTag: e.target.value })}
        className={selectClass}
      >
        <option value="all">All Exits</option>
        <option value="HIT_TARGET">Hit Target</option>
        <option value="STOPPED_OUT">Stopped Out</option>
        <option value="MOVED_STOP">Moved Stop</option>
        <option value="PANIC_EXIT">Panic Exit</option>
        <option value="TIME_EXIT">Time Exit</option>
        <option value="REVERSAL_SEEN">Reversal Seen</option>
        <option value="OTHER">Other</option>
      </select>

      {/* Sort By */}
      <select
        value={filters.sortBy}
        onChange={(e) => onFilterChange({ sortBy: e.target.value })}
        className={selectClass}
      >
        <option value="date">Sort: Date</option>
        <option value="pnl">Sort: P&L</option>
        <option value="pnlPercent">Sort: P&L %</option>
        <option value="duration">Sort: Duration</option>
      </select>
    </div>
  );
}
