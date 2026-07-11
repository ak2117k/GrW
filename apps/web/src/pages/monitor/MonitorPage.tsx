import { useEffect, useRef, useState } from 'react';
import { Target, Search, Loader2, X, Plus, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useStockMonitors, type StockMonitor } from '@/hooks/useStockMonitors';
import { useInstrumentSearch, type InstrumentResult } from '@/hooks/useInstrumentSearch';
import { wsService } from '@/services/websocket';
import { formatMoney } from '@/hooks/formatMoney';
import { LoadingSkeleton } from '@/components/common';
import { progressPct } from './monitorMath';

/** Tailwind text color for a signed change value. */
function changeColor(v: number | null | undefined): string {
  const n = typeof v === 'number' ? v : 0;
  if (n > 0) return 'text-[var(--color-accent-green)]';
  if (n < 0) return 'text-[var(--color-accent-red)]';
  return 'text-[var(--color-text-secondary)]';
}

/** "+7.14%" / "-3.20%" / "0.00%" — em-dash when null. */
function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** Nullable rupee amount — em-dash when unset (formatMoney would show ₹0). */
function money(v: number | null | undefined): string {
  return v == null ? '—' : formatMoney(v);
}

const TH = 'py-2 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]';
const THR = `${TH} text-right`;
const TD = 'py-1.5 px-3 tabular-nums text-[var(--color-text-secondary)]';
const TDR = `${TD} text-right`;

/** A pill distinguishing WATCHING (muted) from TARGET_HIT (green). */
function StatusBadge({ status }: { status: StockMonitor['status'] }) {
  const hit = status === 'TARGET_HIT';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        hit
          ? 'bg-[var(--color-accent-green)]/15 text-[var(--color-accent-green)]'
          : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'
      }`}
    >
      {hit ? 'Target Hit' : 'Watching'}
    </span>
  );
}

/** A thin progress bar filled to `pct`% (0–100). */
function ProgressBar({ pct, hit }: { pct: number; hit: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
        <div
          className={`h-full rounded-full transition-[width] ${
            hit ? 'bg-[var(--color-accent-green)]' : 'bg-[var(--color-accent-blue)]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

/** Add form — instrument search (reused hook) + target-profit % → add(). */
function AddMonitorForm({
  onAdd,
}: {
  onAdd: (input: {
    symbol: string;
    exchange: string;
    token: string;
    targetPercent: number;
  }) => Promise<void>;
}) {
  const {
    results,
    isLoading: searchLoading,
    search: doSearch,
    clear: clearSearch,
  } = useInstrumentSearch();
  const [searchText, setSearchText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selected, setSelected] = useState<InstrumentResult | null>(null);
  const [targetText, setTargetText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Drive the API search off the input (mirrors MarketPage).
  useEffect(() => {
    if (selected) return; // a selection freezes the search box
    if (searchText.trim().length >= 2) {
      doSearch(searchText);
      setShowDropdown(true);
    } else {
      clearSearch();
      setShowDropdown(false);
    }
  }, [searchText, selected, doSearch, clearSearch]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = (inst: InstrumentResult) => {
    setSelected(inst);
    setSearchText(inst.symbol);
    setShowDropdown(false);
    clearSearch();
  };

  const reset = () => {
    setSelected(null);
    setSearchText('');
    setTargetText('');
    clearSearch();
  };

  const target = Number.parseFloat(targetText);
  const canSubmit =
    !!selected && Number.isFinite(target) && target > 0 && !submitting;

  const submit = async () => {
    if (!selected || !Number.isFinite(target) || target <= 0) return;
    setSubmitting(true);
    try {
      await onAdd({
        symbol: selected.symbol,
        exchange: selected.exchange,
        token: selected.token,
        targetPercent: target,
      });
      toast.success(`Monitoring ${selected.symbol} for +${target}%`);
      reset();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      toast.error(
        status === 409
          ? `${selected.symbol} is already being monitored.`
          : 'Could not add monitor. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="flex flex-wrap items-end gap-3">
        {/* Instrument search */}
        <div className="relative min-w-[240px] flex-1" ref={containerRef}>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            Stock
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-3 py-2">
            {searchLoading ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-[var(--color-accent-blue)]" />
            ) : (
              <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            )}
            <input
              value={searchText}
              onChange={(e) => {
                setSelected(null);
                setSearchText(e.target.value);
              }}
              onFocus={() => {
                if (!selected && results.length > 0) setShowDropdown(true);
              }}
              placeholder="Search symbol..."
              className="w-full min-w-0 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
            {(searchText || selected) && (
              <button
                onClick={reset}
                className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {showDropdown && !selected && searchText.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-lg">
              {searchLoading && results.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--color-text-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  Searching...
                </div>
              ) : results.length === 0 ? (
                <div className="px-4 py-3 text-sm text-[var(--color-text-muted)]">
                  No instruments found for &ldquo;{searchText}&rdquo;
                </div>
              ) : (
                results.map((inst) => (
                  <button
                    key={`${inst.exchange}-${inst.token}`}
                    onClick={() => pick(inst)}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">
                        {inst.symbol}
                      </span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">{inst.name}</span>
                    </div>
                    <span className="text-[10px] text-[var(--color-text-muted)]">{inst.exchange}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Target profit % */}
        <div className="w-32">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            Target %
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-3 py-2">
            <input
              type="number"
              min="0"
              step="0.1"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit();
              }}
              placeholder="5"
              className="w-full min-w-0 bg-transparent text-sm tabular-nums text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
            <span className="text-xs text-[var(--color-text-muted)]">%</span>
          </div>
        </div>

        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Add Monitor
        </button>
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
        Target profit is measured from the price captured when the stock is added.
      </p>
    </section>
  );
}

export default function MonitorPage() {
  const { data, loading, error, refresh, add, remove } = useStockMonitors();
  const rows = data ?? [];
  const hasRows = rows.length > 0;

  // Toast when the backend fires a target-hit alert (delivered even off-page).
  useEffect(() => {
    const unsubscribe = wsService.subscribe('alert', (payload) => {
      const msg =
        (payload as { message?: string } | null)?.message ??
        'A stock hit its target.';
      toast.success(msg, { icon: '🎯' });
      // Reflect the new TARGET_HIT status without waiting for the next poll.
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Monitor</h1>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <AddMonitorForm onAdd={add} />

      {error && (
        <div className="rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 p-4 text-sm text-[var(--color-accent-red)]">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
        <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">
          Monitored Stocks
        </h2>

        {loading && !data && <LoadingSkeleton variant="card" count={1} className="m-3 h-24" />}

        {!loading && !error && !hasRows && (
          <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No stocks monitored yet. Add one above to start watching for a target.
          </p>
        )}

        {hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)]">
                  <th className={TH}>Symbol</th>
                  <th className={THR}>Ref Price</th>
                  <th className={THR}>LTP</th>
                  <th className={THR}>Change %</th>
                  <th className={THR}>Target %</th>
                  <th className={THR}>Target Price</th>
                  <th className={TH}>Progress</th>
                  <th className={TH}>Status</th>
                  <th className={THR}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-[var(--color-border-subtle)] last:border-0"
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-medium text-[var(--color-text-primary)]">{m.symbol}</span>
                      <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">
                        {m.exchange}
                      </span>
                    </td>
                    <td className={TDR}>{money(m.referencePrice)}</td>
                    <td className={TDR}>{money(m.lastLtp)}</td>
                    <td className={`${TDR} ${changeColor(m.currentPercent)}`}>
                      {fmtPct(m.currentPercent)}
                    </td>
                    <td className={TDR}>{fmtPct(m.targetPercent)}</td>
                    <td className={TDR}>{money(m.targetPrice)}</td>
                    <td className="px-3 py-1.5">
                      <ProgressBar
                        pct={progressPct(m.currentPercent, m.targetPercent)}
                        hit={m.status === 'TARGET_HIT'}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => void remove(m.id)}
                        title="Remove monitor"
                        className="rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-accent-red)]/20 hover:text-[var(--color-accent-red)]"
                      >
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
