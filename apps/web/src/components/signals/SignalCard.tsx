import { useState } from 'react';
import clsx from 'clsx';
import { SymbolChartLink } from '@/components/common';
import ChartinkScoreTable from '@/components/chartink/ChartinkScoreTable';
import { TiltCard } from '@/components/depth';
import type { AnandEntry } from '@/services/anand';
import { signalPnl } from './signal-card';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtSignedRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inrFmt.format(Math.abs(Math.round(n)))}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const moneyColor = (n: number | null) =>
  n == null ? 'text-[var(--color-text-muted)]' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]';

const STATUS_TONE: Record<string, string> = {
  TRADED: 'bg-blue-500/15 text-blue-300',
  TARGET_HIT: 'bg-emerald-500/15 text-emerald-300',
  STOPPED: 'bg-red-500/15 text-red-300',
  EXPIRED: 'bg-gray-500/15 text-gray-300',
};

/** One interactive signal as a depth card. USER path renders NO provenance;
 *  scanner/score/trailing/exitReason live only in the ADMIN-gated expander. */
export function SignalCard({ entry, isAdmin, notional }: { entry: AnandEntry; isAdmin: boolean; notional: number }) {
  const [open, setOpen] = useState(false);
  const { pnlRs, pnlPct, priceShown, stale } = signalPnl(entry, notional);
  const isActive = entry.exitPrice == null;

  return (
    <TiltCard maxTiltDeg={6}>
      <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-base font-semibold text-[var(--color-text-primary)]">
              <SymbolChartLink symbol={entry.symbol} token={entry.token} />
            </span>
            <span className="text-xs text-[var(--color-text-muted)] tabular-nums">Entry ₹{entry.entryPrice.toFixed(2)} · Tgt {entry.targetPct}%</span>
          </div>
          <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', STATUS_TONE[entry.status] ?? 'bg-gray-500/15 text-gray-300')}>
            {entry.status.replace('_', ' ')}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{isActive ? 'Live' : 'Exit'} Price</div>
            <div className="text-lg font-semibold tabular-nums text-[var(--color-text-primary)]">
              {stale ? <span className="text-[var(--color-text-muted)]">— stale</span> : `₹${priceShown.toFixed(2)}`}
            </div>
          </div>
          <div className="text-right">
            <div className={clsx('text-lg font-bold tabular-nums', moneyColor(pnlRs))}>{pnlRs == null ? '—' : fmtSignedRs(pnlRs)}</div>
            <div className={clsx('text-xs tabular-nums', moneyColor(pnlPct))}>{pnlPct == null ? '' : fmtPct(pnlPct)}</div>
          </div>
        </div>

        {isAdmin && (
          <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-2">
            <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              {open ? 'Hide' : 'Show'} internals {entry.scannerName ? `· ${entry.scannerName}` : ''}
            </button>
            {open && entry.scoreBreakdown && (
              <div className="mt-2">
                <ChartinkScoreTable
                  score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
                  lotCount={0}
                  checks={entry.scoreBreakdown}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </TiltCard>
  );
}
