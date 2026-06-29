import { useEffect, useState } from 'react';
import { watchApi } from '../../services/watch.service';
import type { WatchEntry, WatchEntryWithEvents } from '../../types/watch.types';
import { WatchEventLog } from './WatchEventLog';
import { TrailingStopSection } from './TrailingStopSection';

interface Props {
  entryId: string;
  entry?: WatchEntry;
  onClose?: () => void;
  fetchEntry?: (id: string) => Promise<WatchEntryWithEvents>;
}

export function WatchDetailPanel({ entryId, entry: liveEntry, onClose, fetchEntry }: Props) {
  const [detail, setDetail] = useState<WatchEntryWithEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doFetch = fetchEntry ?? watchApi.get.bind(watchApi);

  async function refresh() {
    setError(null);
    try {
      const data = await doFetch(entryId);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { refresh(); }, [entryId]);

  async function execute(mode: 'paper' | 'live') {
    setBusy(true);
    setError(null);
    try { await watchApi.execute(entryId, mode); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function dismiss() {
    setBusy(true);
    try { await watchApi.dismiss(entryId); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Live-first: prefer the polled entry from the table (so the stat grid +
  // trail section refresh live), fall back to the fetched detail. The event
  // log always reads from `detail` (only the fetch carries events).
  const view: WatchEntry | WatchEntryWithEvents | null = liveEntry ?? detail;

  if (!view) {
    return (
      <div className="p-4 flex items-start justify-between text-[var(--color-text-muted)]">
        <span>{error ? `Error: ${error}` : 'Loading…'}</span>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-xl leading-none px-1"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 bg-[var(--color-bg-secondary)] border border-[var(--color-border-subtle)] rounded text-[var(--color-text-primary)]">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <span className="font-mono text-lg text-[var(--color-text-primary)]">{view.symbol}</span>
          <span className="ml-2 text-[var(--color-text-secondary)]">{view.side}</span>
          {(() => {
            const isTrailing = view.status === 'TRADED' && view.partialExitedAt != null;
            const label = isTrailing ? 'TRAILING' : view.status;
            const cls = isTrailing
              ? 'bg-amber-500/20 text-amber-300'
              : view.status === 'WATCHING'
                ? 'bg-blue-500/20 text-blue-300'
                : view.status === 'TRADED'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : view.status === 'TARGET_HIT'
                    ? 'bg-emerald-600/30 text-emerald-200'
                    : view.status === 'STOPPED'
                      ? 'bg-red-500/20 text-red-300'
                      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]';
            return (
              <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
                {label}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            {new Date(view.initialAt).toLocaleString('en-IN')}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-xl leading-none px-1"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm mb-4">
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Initial</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{view.initialPrice.toFixed(2)} (score {view.initialScore})
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Current</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{(view.currentPrice ?? view.initialPrice).toFixed(2)} (score {view.currentScore ?? view.initialScore})
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Target</div>
          <div className="text-[var(--color-text-primary)]">
            ₹{view.profitTarget.toFixed(2)} <span className="text-[var(--color-text-muted)] text-xs">({view.profitTargetSource})</span>
          </div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Max Favorable</div>
          <div className="text-[var(--color-text-primary)]">₹{view.maxFavorable?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">Max Adverse</div>
          <div className="text-[var(--color-text-primary)]">₹{view.maxAdverse?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[var(--color-text-muted)] text-xs">SL (score)</div>
          <div className="text-[var(--color-text-primary)]">&lt; {view.stopLossScore}</div>
        </div>
      </div>

      {view.optionsToken && (
        <div className="text-sm mb-4 p-2 bg-[var(--color-bg-tertiary)] rounded">
          <div className="text-xs text-[var(--color-text-muted)] mb-1">Options leg</div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {view.symbol} {view.optionsStrike} {view.optionsType}
            {view.optionsExpiry && (
              <> · expires {new Date(view.optionsExpiry).toLocaleDateString('en-IN')}</>
            )}
            {view.optionsSelectionScore != null && (
              <> · rank-score {view.optionsSelectionScore.toFixed(3)}</>
            )}
          </div>
        </div>
      )}

      <TrailingStopSection entry={view} />

      <div className="mb-4">
        <div className="text-xs text-[var(--color-text-muted)] mb-2">Event log</div>
        {detail == null ? (
          <div className="text-xs text-[var(--color-text-muted)]">Loading events…</div>
        ) : (
          <WatchEventLog events={detail.events} />
        )}
      </div>

      {view.status === 'WATCHING' && (
        <div className="flex gap-2">
          <button
            onClick={() => execute('paper')}
            disabled={busy}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
          >
            Execute Paper
          </button>
          <button
            onClick={() => execute('live')}
            disabled={busy}
            className="px-3 py-1 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-500 transition-colors disabled:opacity-50"
          >
            Execute Live
          </button>
          <button
            onClick={dismiss}
            disabled={busy}
            className="px-3 py-1 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] text-sm rounded hover:bg-[var(--color-bg-tertiary)]/70 transition-colors disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
    </div>
  );
}
