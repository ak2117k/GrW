import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { CapitalStrip } from '@/components/anand/CapitalStrip';
import type { PnlSummary, PnlPeriod } from '@/services/anand';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtSignedRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inrFmt.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]');

function PnlTile({ label, period }: { label: string; period: PnlPeriod }) {
  const has = period.count > 0;
  return (
    <TiltCard maxTiltDeg={5} className="flex-1 min-w-[150px]">
      <div className="glass-panel depth-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
        <div className={clsx('mt-1 text-xl font-bold tabular-nums', has ? moneyColor(period.totalPnlRs) : 'text-[var(--color-text-muted)]')}>
          {has ? fmtSignedRs(period.totalPnlRs) : '—'}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] tabular-nums">{has ? `${period.count}t · ${period.winCount}W` : '— · —'}</div>
      </div>
    </TiltCard>
  );
}

export function SignalSummaryStrip({
  pnl, openCount, invested, currentValue, unrealizedRs,
}: { pnl?: PnlSummary; openCount: number; invested: number; currentValue: number; unrealizedRs: number }) {
  return (
    <div className="flex flex-col gap-3">
      {pnl && (
        <div className="flex flex-wrap gap-3">
          <PnlTile label="Daily" period={pnl.daily} />
          <PnlTile label="Weekly" period={pnl.weekly} />
          <PnlTile label="Monthly" period={pnl.monthly} />
          <PnlTile label="Yearly" period={pnl.yearly} />
        </div>
      )}
      {openCount > 0 && <CapitalStrip openCount={openCount} invested={invested} currentValue={currentValue} unrealizedRs={unrealizedRs} />}
    </div>
  );
}
