import { useEffect, useState } from 'react';
import { Database, ChevronDown, ChevronRight } from 'lucide-react';
import { listBacktestDatasets, type BacktestDataset } from '@/services/backtest-assistant';

function day(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

/** The backtest data store's catalogue: what history backtests can use without a broker fetch. */
export default function BacktestDatasets() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BacktestDataset[] | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open && rows === null) listBacktestDatasets().then(setRows).catch(() => setRows([]));
  }, [open, rows]);

  const shown = (rows ?? []).filter((r) => !filter || r.symbol.includes(filter.toUpperCase()));
  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)]">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Database size={14} />
        Stored history {rows ? `(${rows.length} series)` : ''}
      </button>
      {open && (
        <div className="mt-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter symbol…"
            className="mb-2 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          />
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-[10px] tabular-nums">
              <thead className="sticky top-0 bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
                <tr>
                  <th className="text-left font-medium">Symbol</th>
                  <th className="text-left font-medium">TF</th>
                  <th className="text-left font-medium">From</th>
                  <th className="text-left font-medium">To</th>
                  <th className="text-right font-medium">Bars</th>
                  <th className="text-left font-medium pl-2">Source</th>
                </tr>
              </thead>
              <tbody className="text-[var(--color-text-secondary)]">
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium text-[var(--color-text-primary)]">{r.symbol}</td>
                    <td>{r.interval}</td>
                    <td>{day(r.fromTs)}</td>
                    <td>{day(r.toTs)}</td>
                    <td className="text-right">{r.rows.toLocaleString('en-IN')}</td>
                    <td className="pl-2">{r.source}</td>
                  </tr>
                ))}
                {rows && shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-2 text-center text-[var(--color-text-muted)]">
                      Nothing stored yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Backtests read this store first (finer bars roll up: 1m → 5m/15m/1h). 1d stock series from Yahoo are split-adjusted.
          </p>
        </div>
      )}
    </div>
  );
}
