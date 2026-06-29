import { useState } from 'react';
import { useSellFuturesWatchEntries } from '../../hooks/useSellFuturesWatchEntries';
import { WatchTable } from '../watch/WatchTable';
import { dayRealizedSummary } from '../../utils/watchPnl';
import { useSellFuturesPaperAccount } from '../../hooks/useSellFuturesPaperAccount';
import { getSellFuturesEntry } from '../../services/sellFuturesWatch';
import type { WatchStatus } from '../../types/watch.types';

const FILTERS: Array<{ label: string; value: WatchStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
];

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function SellFuturesPage() {
  const [filter, setFilter] = useState<WatchStatus | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIST());
  const { entries, loading, error } = useSellFuturesWatchEntries(filter, date);
  const { account } = useSellFuturesPaperAccount();
  const activeCount = entries.filter((e) => e.status === 'WATCHING' || e.status === 'TRADED').length;

  return (
    <div className="p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h1 className="text-2xl font-semibold">
          SELL-Futures (Short){' '}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 align-middle ml-2">EXPERIMENT</span>
        </h1>
        <div className="flex items-center gap-4 text-sm text-[var(--color-text-muted)]">
          {account && <span>Equity ₹{Math.round(account.equity).toLocaleString('en-IN')}</span>}
          <span>{activeCount} / 25 active</span>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto px-2 py-1 text-sm rounded bg-[var(--color-bg-tertiary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <>
          <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} fetchEntry={getSellFuturesEntry} />
          {(() => {
            const s = dayRealizedSummary(entries);
            if (s.count === 0) return null;
            const fmt = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toFixed(2)}`;
            const color = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]');
            return (
              <div className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    Day realised — {s.count} closed trade{s.count === 1 ? '' : 's'}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 tabular-nums">
                    <div><span className="text-[var(--color-text-muted)]">Gross </span><span className={`font-semibold ${color(s.gross)}`}>{fmt(s.gross)}</span></div>
                    <div><span className="text-[var(--color-text-muted)]">Charges </span><span className="font-semibold text-amber-400">−₹{s.charges.toFixed(2)}</span></div>
                    <div><span className="text-[var(--color-text-muted)]">Net </span><span className={`font-semibold ${color(s.net)}`}>{fmt(s.net)}</span></div>
                  </div>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
