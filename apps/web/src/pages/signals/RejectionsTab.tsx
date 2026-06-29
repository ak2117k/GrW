import { Filter, RefreshCw, Loader2, Slash } from 'lucide-react';
import { cn } from '@/utils/cn';
import { EmptyState, LoadingSkeleton, SymbolChartLink } from '@/components/common';
import { useChartinkRejections } from '@/hooks/useChartinkRejections';
import type {
  RejectionKindCount,
  RejectionRow,
  RejectionSummary,
} from '@/services/chartink';
import { FACTOR_COLUMNS } from '@/utils/factorColumns';

// --- Pure helpers (unit-tested in RejectionsTab.spec.ts) -------------------

export interface KindBreakdownRow extends RejectionKindCount {
  /** Bar width as a whole-number percentage of the largest count. */
  pct: number;
}

/**
 * Sort rejection kinds by count desc and attach a bar width (`pct`) relative
 * to the largest count, so the UI can render a simple horizontal bar per kind.
 */
export function buildKindBreakdown(
  byKind: RejectionKindCount[],
): KindBreakdownRow[] {
  const sorted = [...byKind].sort((a, b) => b.count - a.count);
  const max = sorted.length > 0 ? sorted[0].count : 0;
  return sorted.map((r) => ({
    ...r,
    pct: max > 0 ? Math.round((r.count / max) * 100) : 0,
  }));
}

/** accepted / totalProcessed as a whole-number percentage (0 when nothing processed). */
export function acceptanceRate(summary: RejectionSummary): number {
  if (!summary.totalProcessed) return 0;
  return Math.round((summary.accepted / summary.totalProcessed) * 100);
}

/**
 * Look up the matching check in a rejection row's per-factor breakdown.
 * Returns null when the row had no breakdown (scoring never ran) or the
 * factor isn't in the row — the cell renderer falls back to "·" then.
 */
export function factorPoints(
  breakdown: RejectionRow['scoreBreakdown'],
  factorName: string,
): { points: number; pointsPossible: number; passed: boolean } | null {
  if (!breakdown) return null;
  const c = breakdown.find((x) => x.name === factorName);
  return c
    ? { points: c.points, pointsPossible: c.pointsPossible, passed: c.passed }
    : null;
}

// --- Presentation ----------------------------------------------------------

function kindColor(kind: string): string {
  switch (kind) {
    case 'error':
      return 'bg-red-500/20 text-red-300 border-red-500/40';
    case 'scored-low':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'no-direction':
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
    case 'unresolved':
      return 'bg-gray-500/20 text-gray-300 border-gray-500/40';
    default:
      // mtf-misaligned / macd-misaligned / supertrend-misaligned
      return 'bg-violet-500/20 text-violet-300 border-violet-500/40';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function FunnelStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'neutral' | 'good' | 'bad';
}) {
  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-800/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 text-xl font-extrabold',
          tone === 'good' && 'text-emerald-300',
          tone === 'bad' && 'text-red-300',
          tone === 'neutral' && 'text-gray-100',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function KindBar({ row }: { row: KindBreakdownRow }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'w-44 shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold',
          kindColor(row.kind),
        )}
      >
        {row.kind}
      </span>
      <div className="relative h-4 flex-1 overflow-hidden rounded bg-gray-800/70">
        <div
          className="h-full rounded bg-amber-500/60"
          style={{ width: `${row.pct}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-bold tabular-nums text-gray-200">
        {row.count}
      </span>
    </div>
  );
}

/**
 * One factor cell on a rejection row. Shows the obtained `points` value
 * (green when `passed`, red otherwise) with a `factor — points/possible`
 * tooltip; a muted "·" when the row has no breakdown OR the factor is
 * absent from it (e.g. unresolved / no-direction / error kinds).
 */
function FactorScoreCell({
  factor,
  breakdown,
}: {
  factor: { name: string };
  breakdown: RejectionRow['scoreBreakdown'];
}) {
  const pts = factorPoints(breakdown, factor.name);
  if (!pts) {
    return (
      <td className="px-2 py-2 text-center tabular-nums">
        <span className="text-gray-500">·</span>
      </td>
    );
  }
  return (
    <td
      className="px-2 py-2 text-center tabular-nums"
      title={`${factor.name} — ${pts.points}/${pts.pointsPossible}`}
    >
      <span className={pts.passed ? 'text-emerald-300' : 'text-red-300'}>
        {pts.points}
      </span>
    </td>
  );
}

function RejectionsTable({ rows }: { rows: RejectionRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-700/60">
      <table className="w-full text-sm">
        <thead className="bg-gray-800/60 text-left text-[11px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Scanner</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2 text-right">Score</th>
            {FACTOR_COLUMNS.map((f) => (
              <th
                key={f.name}
                className="px-2 py-2 text-center font-medium"
                title={f.name}
              >
                {f.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-gray-700/50 hover:bg-gray-800/40"
            >
              <td className="px-3 py-2 tabular-nums text-gray-400">
                {formatTime(r.processedAt)}
              </td>
              <td className="px-3 py-2 font-mono font-semibold text-gray-100">
                <SymbolChartLink symbol={r.symbol} />
              </td>
              <td className="px-3 py-2 text-gray-400">{r.scanner}</td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                    kindColor(r.kind),
                  )}
                >
                  {r.kind}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-400">{r.reason}</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-300">
                {r.score ?? '—'}
              </td>
              {FACTOR_COLUMNS.map((f) => (
                <FactorScoreCell key={f.name} factor={f} breakdown={r.scoreBreakdown} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RejectionsTab() {
  const { date, setDate, summary, rejections, isLoading, refresh } =
    useChartinkRejections();

  const breakdown = buildKindBreakdown(summary.byKind);
  const acceptPct = acceptanceRate(summary);

  return (
    <div className="space-y-4">
      {/* Sub-toolbar: date filter + refresh */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-700/60 bg-gray-900/40 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <Filter size={12} />
          <span>Day</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-gray-700 bg-gray-800/60 px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-amber-500/60"
          />
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-all',
            isLoading
              ? 'bg-amber-500/20 text-amber-400 cursor-wait'
              : 'bg-gray-700/60 text-gray-200 hover:bg-gray-700',
          )}
        >
          {isLoading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="card" count={1} />
      ) : summary.totalProcessed === 0 ? (
        <EmptyState
          icon={<Slash size={48} />}
          title="No Chartink hits processed for this day"
          description="Pick a trading day when Chartink alerts fired. Rejections show why scanned stocks did not become trades."
          action={{ label: 'Refresh', onClick: refresh }}
        />
      ) : (
        <>
          {/* Summary strip: funnel + by-kind breakdown */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Funnel */}
            <div className="rounded-xl border border-gray-700/60 bg-gray-900/60 p-4">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Funnel
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <FunnelStat
                  label="Processed"
                  value={summary.totalProcessed}
                  tone="neutral"
                />
                <FunnelStat
                  label="Accepted"
                  value={summary.accepted}
                  tone="good"
                />
                <FunnelStat
                  label="Rejected"
                  value={summary.rejected}
                  tone="bad"
                />
              </div>
              <p className="mt-3 text-[11px] text-gray-500">
                {summary.totalProcessed} processed →{' '}
                <span className="text-emerald-300">
                  {summary.accepted} accepted
                </span>{' '}
                /{' '}
                <span className="text-red-300">
                  {summary.rejected} rejected
                </span>{' '}
                · {acceptPct}% acceptance
              </p>
            </div>

            {/* By-kind breakdown */}
            <div className="rounded-xl border border-gray-700/60 bg-gray-900/60 p-4">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Rejection reasons
              </div>
              <div className="mt-3 space-y-2">
                {breakdown.length === 0 ? (
                  <p className="text-[11px] text-gray-500">
                    No rejections — every processed hit was accepted.
                  </p>
                ) : (
                  breakdown.map((row) => <KindBar key={row.kind} row={row} />)
                )}
              </div>
            </div>
          </div>

          {/* Recent rejections table */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-gray-500">
              Recent rejections ({rejections.length})
            </div>
            {rejections.length === 0 ? (
              <EmptyState
                icon={<Slash size={40} />}
                title="No individual rejections"
                description="All processed Chartink hits for this day were accepted."
              />
            ) : (
              <RejectionsTable rows={rejections} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
