import { useState } from 'react';
import clsx from 'clsx';
import { useSwingEntries } from '../../hooks/useSwingEntries';
import { useSwingExits } from '../../hooks/useSwingExits';
import { useSwingOpenBook } from '../../hooks/useSwingOpenBook';
import { useSwingCapital } from '../../hooks/useSwingCapital';
import { summarizeOpenBook } from '../../utils/swingOpenBook';
import { CapitalStrip } from '../../components/anand/CapitalStrip';
import { SignalCard, SignalSummaryStrip } from '@/components/signals';
import { useAuthStore } from '../../stores/auth-store';
import { useSubscriptions, shouldShowSubscribeCard } from '../../hooks/useSubscriptions';
import { SubscribeCard } from '../../components/product/SubscribeCard';
import type { AnandEntry } from '../../services/anand';

const ENTRY_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
] as const;

const EXIT_FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
] as const;

const NOTIONAL = 200_000;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** IST date N days before today, as YYYY-MM-DD. Used to default the Recent
 *  Exits window to a recent lookback so multi-day cuts aren't hidden. */
function daysAgoIST(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const rsFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function fmtRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${rsFmt.format(Math.abs(n))}`;
}

function rsColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}

/** Card-feed grid for a section of swing signals. Replaces the old dense table:
 *  same loading/error/empty states, rendered as responsive SignalCards. */
function SignalGrid({
  entries,
  loading,
  error,
  emptyMessage,
  isAdmin,
}: {
  entries: AnandEntry[];
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  isAdmin: boolean;
}) {
  if (loading) return <div className="text-[var(--color-text-muted)]">Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (entries.length === 0)
    return <div className="glass-panel p-8 text-center text-[var(--color-text-muted)]">{emptyMessage}</div>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => <SignalCard key={e.id} entry={e} isAdmin={isAdmin} notional={NOTIONAL} />)}
    </div>
  );
}

export default function SwingPage() {
  // NOTE: all hooks are called unconditionally before any early return, so the
  // hook order is stable regardless of role/subscription branching below.
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(todayIST());
  // Default exit window is a wide 90-day lookback so a recently-closed trade is
  // never silently hidden (the old 7-day default cut off an 8-day-old
  // target-hit). When a SPECIFIC terminal status is selected below, the date
  // floor is dropped entirely (all-time for that status) so it's always findable.
  const [exitFrom, setExitFrom] = useState(daysAgoIST(90));
  const [exitStatus, setExitStatus] = useState<string | undefined>(undefined);
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'ADMIN';
  const subs = useSubscriptions();
  // Only fetch the plan-gated data once access is known — otherwise an
  // unsubscribed USER fires 403s that would flash before the gate resolves.
  const canView = isAdmin || subs.swing;
  const { entries, pnl, loading, error } = useSwingEntries(filter, from, canView);
  // Recent Exits: closed/exited swing positions filtered by EXIT date and
  // status. The Entries log above filters by ENTRY date, so a multi-day swing
  // entered earlier but cut recently shows nowhere — this section surfaces it.
  // Selecting a specific status shows ALL-TIME results for it (no date floor).
  const { exits, loading: exitsLoading, error: exitsError } = useSwingExits(
    exitStatus ? undefined : exitFrom,
    exitStatus,
    canView,
  );
  // Capital summary: engaged vs available, recycles as positions exit.
  const { capital } = useSwingCapital(canView);
  // Total realized P&L of the listed exits, using the same per-row notional
  // basis SignalCard uses for its P&L ₹ ((pnlPct / 100) * NOTIONAL).
  const exitsRealizedRs = exits.reduce(
    (sum, e) => sum + (e.pnlPct == null ? 0 : (e.pnlPct / 100) * NOTIONAL),
    0,
  );
  // Open Book: every currently-open position (status TRADED), with NO date
  // filter — the live-exposure source of truth. Kept separate from the
  // date-filtered `entries` above so overnight/multi-day positions are always
  // visible and counted, even when the From date excludes their entry day.
  const { openEntries, loading: openLoading, error: openError } = useSwingOpenBook(canView);
  const { openCount, invested, currentValue, unrealizedRs } = summarizeOpenBook(openEntries, NOTIONAL);

  // While the subscription status is still resolving, show a quiet loading
  // state — NOT the tables (which would surface the gated data calls' 403s).
  if (!isAdmin && subs.loading) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="text-[var(--color-text-muted)]">Loading…</div>
      </div>
    );
  }

  // Gate: an unsubscribed USER (non-admin) sees the Subscribe placeholder
  // instead of the signals tables. Branch happens AFTER all hooks above.
  if (shouldShowSubscribeCard(isAdmin, subs.loading, subs.swing)) {
    return (
      <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <SubscribeCard segment="Swing" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Swing</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        {openCount > 0 && (
          <span className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums glass-panel', unrealizedRs > 0 ? 'text-emerald-400' : unrealizedRs < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]')}>
            {unrealizedRs >= 0 ? '+' : '−'}₹{Math.abs(Math.round(unrealizedRs)).toLocaleString('en-IN')} unrealized
          </span>
        )}
      </div>

      {/* Shared P&L tiles. Capital is rendered separately below via CapitalStrip
          so the swing-specific Available/Realized cells are preserved (the
          strip's built-in capital omits them). openCount=0 suppresses the
          strip's own capital row to avoid a duplicate. */}
      <SignalSummaryStrip pnl={pnl ?? undefined} openCount={0} invested={0} currentValue={0} unrealizedRs={0} />

      {openCount > 0 && (
        <CapitalStrip
          openCount={openCount}
          invested={invested}
          currentValue={currentValue}
          unrealizedRs={unrealizedRs}
          available={capital?.available}
          realizedRs={capital?.realizedPnl}
        />
      )}

      {/* Open Book — every currently-open position, always shown regardless of
          the date filter below. This is the live book that holds overnight. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Open Book · {openCount} open
        </h2>
        <SignalGrid
          entries={openEntries}
          loading={openLoading}
          error={openError}
          emptyMessage="No open positions."
          isAdmin={isAdmin}
        />
      </section>

      {/* Entries log — date- and status-filtered history, for auditing what
          fired on a given day. These controls scope only this section. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Entries
        </h2>
        <div className="flex flex-wrap gap-2">
          {ENTRY_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.value)}
              className={clsx(
                'rounded-full px-3 py-1 text-sm transition-colors',
                filter === f.value
                  ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {f.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <label>From:</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
            />
          </div>
        </div>

        <SignalGrid
          entries={entries}
          loading={loading}
          error={error}
          emptyMessage="No swing entries yet. Waiting for Anand Swing scanner alerts."
          isAdmin={isAdmin}
        />
      </section>

      {/* Recent Exits — closed positions filtered by EXIT date. Surfaces
          multi-day swings entered earlier but cut recently, which the
          entry-date-filtered Entries log above cannot show. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          Recent Exits
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {EXIT_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setExitStatus(f.value)}
              className={clsx(
                'rounded-full px-3 py-1 text-sm transition-colors',
                exitStatus === f.value
                  ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)]'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {f.label}
            </button>
          ))}
          {exits.length > 0 && (
            <span className="text-sm text-[var(--color-text-muted)]">
              {exits.length} exit{exits.length === 1 ? '' : 's'} ·{' '}
              <span className={rsColor(exitsRealizedRs)}>{fmtRs(exitsRealizedRs)} realized</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            {exitStatus ? (
              <span className="italic">Showing all-time {exitStatus.replace('_', ' ').toLowerCase()} exits</span>
            ) : (
              <>
                <label>Exited from:</label>
                <input
                  type="date"
                  value={exitFrom}
                  onChange={(e) => setExitFrom(e.target.value)}
                  className="rounded-lg bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
                />
              </>
            )}
          </div>
        </div>

        <SignalGrid
          entries={exits}
          loading={exitsLoading}
          error={exitsError}
          emptyMessage="No swing exits in this range."
          isAdmin={isAdmin}
        />
      </section>
    </div>
  );
}
