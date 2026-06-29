import { useMemo, useState } from 'react';
import { Briefcase, Plus } from 'lucide-react';
import { useTrades } from '@/hooks/useTrades';
import { useTradeStore } from '@/stores/trade-store';
import {
  PositionRow,
  RiskStatusBar,
  ExecuteTradeModal,
} from '@/components/trading';
import { EmptyState, LoadingSkeleton } from '@/components/common';
import { cn } from '@/utils/cn';
import type { Position } from '@/types';

// Known F&O / commodity underlyings. We detect these as a prefix on the
// position symbol (e.g. "NIFTY26APR24500CE" → "NIFTY"). Anything else is
// treated as an equity and grouped under its own symbol.
const KNOWN_UNDERLYINGS = [
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTY',
  'SENSEX',
  'BANKEX',
  'CRUDEOIL',
  'COPPER',
  'NATURALGAS',
  'GOLD',
  'SILVER',
] as const;

function deriveUnderlying(symbol: string): string {
  const upper = symbol.toUpperCase();
  for (const u of KNOWN_UNDERLYINGS) {
    if (upper.startsWith(u)) return u;
  }
  return upper;
}

interface UnderlyingGroup {
  underlying: string;
  count: number;
  pnl: number;
}

function groupByUnderlying(positions: Position[]): UnderlyingGroup[] {
  const map = new Map<string, UnderlyingGroup>();
  for (const p of positions) {
    const key = deriveUnderlying(p.symbol);
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.pnl += p.pnl;
    } else {
      map.set(key, { underlying: key, count: 1, pnl: p.pnl });
    }
  }
  // Sort: highest absolute exposure (count) first, then alphabetical.
  return Array.from(map.values()).sort(
    (a, b) => b.count - a.count || a.underlying.localeCompare(b.underlying),
  );
}

function formatINR(amount: number, opts?: { withSign?: boolean }): string {
  const formatted = amount.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
  if (opts?.withSign && amount > 0) return `+${formatted}`;
  return formatted;
}

function LossBudgetWidget({
  remaining,
  limit,
}: {
  remaining: number;
  limit: number;
}) {
  // Clamp remaining at 0 — once daily loss exceeds the limit there is no
  // budget left, even if the math goes negative.
  const safeRemaining = Math.max(0, remaining);
  const percentRemaining = limit > 0 ? (safeRemaining / limit) * 100 : 0;

  let tone: 'good' | 'warn' | 'bad';
  if (percentRemaining > 50) tone = 'good';
  else if (percentRemaining >= 20) tone = 'warn';
  else tone = 'bad';

  const toneStyles = {
    good: {
      border: 'border-emerald-500/30',
      bg: 'bg-emerald-500/5',
      text: 'text-emerald-400',
      label: 'Healthy headroom',
    },
    warn: {
      border: 'border-amber-500/30',
      bg: 'bg-amber-500/5',
      text: 'text-amber-400',
      label: 'Trade carefully',
    },
    bad: {
      border: 'border-red-500/40',
      bg: 'bg-red-500/5',
      text: 'text-red-400',
      label: 'Near daily loss limit',
    },
  }[tone];

  return (
    <div
      className={cn(
        'rounded-xl border px-6 py-5',
        toneStyles.border,
        toneStyles.bg,
      )}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            Left to lose today
          </div>
          <div className={cn('text-4xl font-bold', toneStyles.text)}>
            {formatINR(safeRemaining)}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            of {formatINR(limit)} daily loss limit
          </div>
        </div>
        <div className="text-right">
          <div className={cn('text-sm font-semibold', toneStyles.text)}>
            {toneStyles.label}
          </div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1">
            {percentRemaining.toFixed(0)}% remaining
          </div>
        </div>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-gray-700/50 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            tone === 'good'
              ? 'bg-emerald-500'
              : tone === 'warn'
                ? 'bg-amber-500'
                : 'bg-red-500',
          )}
          style={{ width: `${Math.min(percentRemaining, 100)}%` }}
        />
      </div>
    </div>
  );
}

function UnderlyingSummaryStrip({ groups }: { groups: UnderlyingGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
        Positions by underlying
      </div>
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => {
          const isProfit = g.pnl >= 0;
          return (
            <div
              key={g.underlying}
              className={cn(
                'flex items-center gap-3 rounded-md border px-3 py-2 text-xs',
                isProfit
                  ? 'border-emerald-500/20 bg-emerald-500/5'
                  : 'border-red-500/20 bg-red-500/5',
              )}
            >
              <span className="font-semibold text-[var(--color-text-primary)]">
                {g.underlying}
              </span>
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {g.count} pos
              </span>
              <span
                className={cn(
                  'font-medium',
                  isProfit ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {formatINR(g.pnl, { withSign: true })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PositionsPage() {
  const { positions, riskStatus, isLoading } = useTrades();
  const closeTrade = useTradeStore((s) => s.closeTrade);
  const openTrades = useTradeStore((s) => s.openTrades);

  const [showTradeModal, setShowTradeModal] = useState(false);

  const sortedPositions = useMemo(
    () => [...positions].sort((a, b) => b.pnl - a.pnl),
    [positions],
  );

  const groups = useMemo(() => groupByUnderlying(positions), [positions]);

  const totalPnl = useMemo(
    () => positions.reduce((sum, p) => sum + p.pnl, 0),
    [positions],
  );

  const lossRemaining =
    (riskStatus.dailyLossLimit ?? 0) - (riskStatus.dailyLossUsed ?? 0);

  const handleClosePosition = (symbol: string) => {
    const trade = openTrades.find((t) => t.symbol === symbol);
    if (trade) {
      closeTrade(trade.id);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Briefcase size={24} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Positions
          </h1>
          {positions.length > 0 && (
            <span className="text-xs text-[var(--color-text-muted)]">
              {positions.length} open
              {' · '}
              <span
                className={cn(
                  'font-medium',
                  totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {formatINR(totalPnl, { withSign: true })}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Loss budget hero widget */}
      <LossBudgetWidget
        remaining={lossRemaining}
        limit={riskStatus.dailyLossLimit ?? 0}
      />

      {/* Full risk status bar (capital, position count, etc.) */}
      <RiskStatusBar />

      {/* Underlying summary strip */}
      <UnderlyingSummaryStrip groups={groups} />

      {/* Main positions list */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border-subtle)]">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Open Positions
            {positions.length > 0 && (
              <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
                (sorted by P&amp;L)
              </span>
            )}
          </h2>
        </div>

        {isLoading && positions.length === 0 ? (
          <div className="p-4 space-y-2">
            <LoadingSkeleton variant="table-row" count={4} />
          </div>
        ) : sortedPositions.length === 0 ? (
          <EmptyState
            icon={<Briefcase size={48} />}
            title="No open positions"
            description="Place a paper trade to start tracking exposure here."
            action={{
              label: 'Place a paper trade',
              onClick: () => setShowTradeModal(true),
            }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">Side</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                  <th className="px-4 py-2 font-medium text-right">Avg Price</th>
                  <th className="px-4 py-2 font-medium text-right">LTP</th>
                  <th className="px-4 py-2 font-medium text-right">P&amp;L</th>
                  <th className="px-4 py-2 font-medium text-right">P&amp;L%</th>
                  <th className="px-4 py-2 font-medium text-right"></th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((position) => (
                  <PositionRow
                    key={position.symbol}
                    position={position}
                    onClose={handleClosePosition}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Floating Action Button — quick paper trade entry */}
      <button
        onClick={() => setShowTradeModal(true)}
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-[var(--color-accent-blue)] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-500 transition-all hover:scale-105"
      >
        <Plus size={18} />
        Place Trade
      </button>

      {/* Execute Trade Modal */}
      <ExecuteTradeModal
        isOpen={showTradeModal}
        onClose={() => setShowTradeModal(false)}
      />
    </div>
  );
}
