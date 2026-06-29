import clsx from 'clsx';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rs = (n: number) => `₹${inr.format(Math.round(n))}`;
const signedRs = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) =>
  n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]';

function Cell({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: string;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx('mt-1 text-lg font-semibold tabular-nums', valueClass ?? 'text-[var(--color-text-primary)]')}>
        {value}
      </div>
      {sub && (
        <div className={clsx('mt-0.5 text-xs tabular-nums', valueClass ?? 'text-[var(--color-text-muted)]')}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Capital summary for the Anand tracks: how much is ACTUALLY invested in open
 * positions (whole shares × entry price, ≤ the ₹200k allocation) and its live
 * mark-to-market value. Fed by summarizeOpenBook so the figures stay consistent
 * with the open-positions counter.
 */
export function CapitalStrip({
  openCount,
  invested,
  currentValue,
  unrealizedRs,
  available,
  realizedRs,
}: {
  openCount: number;
  invested: number;
  currentValue: number;
  unrealizedRs: number;
  available?: number;
  realizedRs?: number;
}) {
  const pct = invested > 0 ? (unrealizedRs / invested) * 100 : 0;
  return (
    <div className="flex flex-wrap gap-3">
      <Cell label={`Invested · ${openCount} open`} value={rs(invested)} />
      {available != null && <Cell label="Available" value={rs(available)} />}
      <Cell label="Current Value" value={rs(currentValue)} />
      <Cell
        label="Unrealized"
        value={signedRs(unrealizedRs)}
        valueClass={moneyColor(unrealizedRs)}
        sub={`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
      />
      {realizedRs != null && (
        <Cell label="Realized" value={signedRs(realizedRs)} valueClass={moneyColor(realizedRs)} />
      )}
    </div>
  );
}
