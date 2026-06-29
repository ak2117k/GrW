import { usePaperAccount } from '../../hooks/usePaperAccount';

function fmtINR(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/**
 * Compact paper-trading balance widget. Shows:
 *   - Equity   = balance + deployed + unrealized P&L + pending (total value)
 *   - Cash     = idle cash not tied up in positions
 *   - Deployed = capital locked in open positions
 *   - Unreal   = unrealized P&L from live ticks (color-coded)
 *   - Pending  = profit from winning exits, credited at the 18:00 settlement
 *
 * Polls /api/trades/paper-account every 5s.
 */
export function PaperAccountBadge() {
  const { account, error } = usePaperAccount();

  if (error) {
    return (
      <div
        className="text-xs px-3 py-1.5 rounded bg-red-500/10 text-red-300 border border-red-500/30"
        title={error}
      >
        Paper acct: err
      </div>
    );
  }

  if (!account) {
    return (
      <div className="text-xs px-3 py-1.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
        Paper acct: …
      </div>
    );
  }

  const totalChange = account.equity - account.startingCapital;
  const totalPct = (totalChange / account.startingCapital) * 100;
  const totalColor =
    totalChange > 0 ? 'text-emerald-300' : totalChange < 0 ? 'text-red-300' : 'text-[var(--color-text-secondary)]';
  const unrealColor =
    account.unrealizedPnl > 0
      ? 'text-emerald-400'
      : account.unrealizedPnl < 0
        ? 'text-red-400'
        : 'text-[var(--color-text-muted)]';

  return (
    <div
      className="flex items-center gap-3 text-xs px-3 py-1.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)]"
      title={`Starting: ${fmtINR(account.startingCapital)} · Tracking since ${new Date(account.epoch).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${account.openPositions} open positions`}
    >
      <span className="text-[var(--color-text-muted)]">PAPER</span>
      <div className="flex items-baseline gap-1">
        <span className="text-[var(--color-text-muted)]">Equity</span>
        <span className={`font-mono font-medium ${totalColor}`}>
          {fmtINR(account.equity)}
        </span>
        <span className={`text-[10px] ${totalColor}`}>
          ({totalChange >= 0 ? '+' : ''}
          {totalPct.toFixed(2)}%)
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[var(--color-text-muted)]">Cash</span>
        <span className="font-mono text-[var(--color-text-primary)]">
          {fmtINR(account.balance)}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[var(--color-text-muted)]">Deployed</span>
        <span className="font-mono text-[var(--color-text-secondary)]">
          {fmtINR(account.deployedCapital)}
        </span>
      </div>
      {account.openPositions > 0 && (
        <div className="flex items-baseline gap-1">
          <span className="text-[var(--color-text-muted)]">Unreal</span>
          <span className={`font-mono ${unrealColor}`}>
            {account.unrealizedPnl >= 0 ? '+' : ''}
            {fmtINR(account.unrealizedPnl)}
          </span>
        </div>
      )}
      {account.pendingProfit > 0 && (
        <div className="flex items-baseline gap-1">
          <span
            className="text-[var(--color-text-muted)]"
            title="Profit from winning exits — credited to cash after the 18:00 IST settlement"
          >
            Pending
          </span>
          <span className="font-mono text-amber-300">
            +{fmtINR(account.pendingProfit)}
          </span>
        </div>
      )}
    </div>
  );
}
