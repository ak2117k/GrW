import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge, EmptyState, LoadingSkeleton, PnLDisplay } from '@/components/common';
import {
  closedByLabel,
  filterLiveTrades,
  getLiveJournal,
  liveTotals,
  type LiveJournalFilter,
  type LiveTradeRow,
} from '@/services/livePortfolio';
import { cn } from '@/utils/cn';

const FILTERS: Array<{ key: LiveJournalFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'OPEN', label: 'Open' },
  { key: 'CLOSED', label: 'Closed' },
  { key: 'AGENT', label: 'AI agent' },
  { key: 'MANUAL', label: 'Manual' },
  { key: 'MODEL', label: 'Model' },
  { key: 'TRIGGER', label: 'Price trigger' },
];

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const price = (n: number | null) => (n == null ? '--' : inr.format(n));
const fmtRs = (n: number) => `${n < 0 ? '−' : ''}₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)))}`;

function fmtDateTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '--', time: '' };
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }),
    time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
  };
}

function closerVariant(r: LiveTradeRow): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  switch (r.closedBy) {
    case 'AGENT':
      return 'info';
    case 'MODEL':
      return 'success';
    case 'TRIGGER':
      return 'warning';
    case 'MANUAL':
      return 'neutral';
    default:
      return 'info';
  }
}

/**
 * Journal → Live: real broker trades (trade_trackers + live trades rows) with who
 * opened and who closed each one. Reads GET /portfolio/live/journal.
 */
export default function LiveJournal() {
  const q = useQuery({ queryKey: ['portfolio', 'live', 'journal'], queryFn: getLiveJournal, refetchInterval: 60_000 });
  const [filter, setFilter] = useState<LiveJournalFilter>('ALL');
  const all = q.data?.trades ?? [];
  const rows = useMemo(() => filterLiveTrades(all, filter), [all, filter]);
  const totals = useMemo(() => liveTotals(all), [all]);

  if (q.isLoading) {
    return (
      <div className="space-y-2">
        <LoadingSkeleton />
      </div>
    );
  }

  if (q.isError) {
    return <EmptyState title="Could not load live trades" description="The live journal will retry automatically." />;
  }

  if (all.length === 0) {
    return (
      <EmptyState
        title="No live trades yet"
        description="Real trades appear here once the broker tracker picks up a position or holding (manual at the broker, AI-agent exits, or model trades)."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Realised P&L" value={fmtRs(totals.realised)} tone={totals.realised} />
        <Stat label={`Open (${totals.open})`} value={fmtRs(totals.unrealised)} tone={totals.unrealised} />
        <Stat label="Closed trades" value={String(totals.closed)} />
        <Stat label="Win rate" value={`${totals.winRate.toFixed(1)}%`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filter === f.key
                ? 'border-blue-400 bg-blue-500/10 text-blue-300'
                : 'border-gray-700 text-gray-400 hover:text-gray-200',
            )}
          >
            {f.label}
          </button>
        ))}
        {q.isFetching && <RefreshCw size={13} className="animate-spin text-gray-500" />}
        <span className="ml-auto text-xs text-gray-500">{rows.length} of {all.length}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="bg-gray-900/60 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2">Entry</th>
              <th className="px-3 py-2">Symbol</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Entry ₹</th>
              <th className="px-3 py-2 text-right">Exit / LTP ₹</th>
              <th className="px-3 py-2 text-right">P&L</th>
              <th className="px-3 py-2">Opened by</th>
              <th className="px-3 py-2">Closed by</th>
              <th className="px-3 py-2">Exit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const entry = fmtDateTime(r.entryTime);
              const exit = fmtDateTime(r.exitTime);
              return (
                <tr key={`${r.origin}-${r.id}`} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2">
                    <div>{entry.date}</div>
                    <div className="text-[10px] text-gray-500">{entry.time}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.symbol}</div>
                    <div className="text-[10px] text-gray-500">
                      {r.exchange} · {r.segment}{r.kind === 'HOLDING' ? ' · holding' : ''}
                    </div>
                  </td>
                  <td className={cn('px-3 py-2 font-semibold', r.side === 'LONG' ? 'text-emerald-400' : 'text-red-400')}>{r.side}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{price(r.entryPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.status === 'CLOSED' ? price(r.exitPrice) : <span className="text-gray-400">{price(r.ltp)}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PnLDisplay value={r.pnl} percent={r.pnlPercent} size="sm" />
                    {r.status === 'OPEN' && <div className="text-[10px] text-gray-500">unrealised</div>}
                  </td>
                  <td className="px-3 py-2">
                    {r.openedBy === 'MODEL' ? 'Model' : 'Manual'}
                    {r.strategy && <div className="text-[10px] text-gray-500">{r.strategy}</div>}
                  </td>
                  <td className="px-3 py-2" title={r.closeNote ?? undefined}>
                    <Badge variant={closerVariant(r)} size="sm" label={closedByLabel(r.closedBy)} />
                    {r.closeNote && <div className="mt-0.5 max-w-[220px] truncate text-[10px] text-gray-500">{r.closeNote}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div>{exit.date}</div>
                    <div className="text-[10px] text-gray-500">{exit.time}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div
        className={cn(
          'text-base font-semibold tabular-nums',
          tone == null ? 'text-gray-200' : tone > 0 ? 'text-emerald-400' : tone < 0 ? 'text-red-400' : 'text-gray-300',
        )}
      >
        {value}
      </div>
    </div>
  );
}
