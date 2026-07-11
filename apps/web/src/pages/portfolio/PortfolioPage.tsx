import { useEffect } from 'react';
import { PieChart, RefreshCw } from 'lucide-react';
import { useBrokerOverview } from '@/hooks/useBrokerOverview';
import { formatMoney } from '@/hooks/formatMoney';
import { LoadingSkeleton } from '@/components/common';

/** Tailwind text color for a signed P&L value. */
function pnlColor(v: number): string {
  if (v > 0) return 'text-[var(--color-accent-green)]';
  if (v < 0) return 'text-[var(--color-accent-red)]';
  return 'text-[var(--color-text-secondary)]';
}

/** "+7.14%" / "-3.20%" / "0.00%" */
function fmtPct(v: number | null | undefined): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function SummaryTile({
  label,
  value,
  pct,
  pnl = false,
}: {
  label: string;
  value: number | null | undefined;
  pct?: number | null;
  pnl?: boolean;
}) {
  const v = typeof value === 'number' ? value : 0;
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-bold tabular-nums ${
          pnl ? pnlColor(v) : 'text-[var(--color-text-primary)]'
        }`}
      >
        {formatMoney(v)}
      </div>
      {pnl && pct != null && (
        <div className={`text-xs tabular-nums ${pnlColor(v)}`}>{fmtPct(pct)}</div>
      )}
    </div>
  );
}

const TH = 'py-2 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]';
const THR = `${TH} text-right`;
const TD = 'py-1.5 px-3 tabular-nums text-[var(--color-text-secondary)]';
const TDR = `${TD} text-right`;

export default function PortfolioPage() {
  const { data, loading, error, notConnected, refresh } = useBrokerOverview();

  // Fetch on mount; the button drives subsequent refreshes (each = one broker login).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PieChart size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Portfolio</h1>
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

      {loading && !data && <LoadingSkeleton variant="card" count={1} className="h-32" />}

      {notConnected && (
        <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
          Connect your Angel One account on the{' '}
          <span className="font-medium text-[var(--color-text-primary)]">Dashboard</span> to see
          your holdings and positions.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 p-4 text-sm text-[var(--color-accent-red)]">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary strip */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Available Cash" value={data.funds?.availableCash} />
            <SummaryTile label="Invested" value={data.holdingSummary?.investedValue} />
            <SummaryTile label="Current Value" value={data.holdingSummary?.currentValue} />
            <SummaryTile
              label="Total P&L"
              value={data.holdingSummary?.totalPnl}
              pct={data.holdingSummary?.totalPnlPercent}
              pnl
            />
          </div>

          {/* Holdings */}
          <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
            <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">
              Holdings
            </h2>
            {data.holdings?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)]">
                      <th className={TH}>Symbol</th>
                      <th className={THR}>Qty</th>
                      <th className={THR}>Avg Cost</th>
                      <th className={THR}>LTP</th>
                      <th className={THR}>Cur. Value</th>
                      <th className={THR}>P&amp;L</th>
                      <th className={THR}>Day %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.map((h, i) => (
                      <tr key={`${h.symbol}-${i}`} className="border-b border-[var(--color-border-subtle)] last:border-0">
                        <td className="px-3 py-1.5">
                          <span className="font-medium text-[var(--color-text-primary)]">{h.symbol}</span>
                          <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">{h.exchange}</span>
                        </td>
                        <td className={TDR}>{h.qty}</td>
                        <td className={TDR}>{formatMoney(h.avgPrice)}</td>
                        <td className={TDR}>{formatMoney(h.ltp)}</td>
                        <td className={TDR}>{formatMoney(h.currentValue)}</td>
                        <td className={`${TDR} ${pnlColor(h.pnl)}`}>
                          {formatMoney(h.pnl)} <span className="text-[10px]">({fmtPct(h.pnlPercent)})</span>
                        </td>
                        <td className={`${TDR} ${pnlColor(h.dayChangePercent)}`}>{fmtPct(h.dayChangePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">No equity holdings.</p>
            )}
          </section>

          {/* Open positions */}
          <section className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)]">
            <h2 className="border-b border-[var(--color-border-subtle)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">
              Open Positions
            </h2>
            {data.positions?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)]">
                      <th className={TH}>Symbol</th>
                      <th className={THR}>Net Qty</th>
                      <th className={THR}>LTP</th>
                      <th className={THR}>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p, i) => (
                      <tr key={`${p.symbol}-${i}`} className="border-b border-[var(--color-border-subtle)] last:border-0">
                        <td className="px-3 py-1.5">
                          <span className="font-medium text-[var(--color-text-primary)]">{p.symbol}</span>
                          <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">{p.exchange}</span>
                        </td>
                        <td className={TDR}>{p.netQty}</td>
                        <td className={TDR}>{formatMoney(p.ltp)}</td>
                        <td className={`${TDR} ${pnlColor(p.pnl)}`}>{formatMoney(p.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">No open positions.</p>
            )}
          </section>

          <p className="text-center text-[10px] text-[var(--color-text-muted)]">
            Values are a live snapshot from Angel One. Press Refresh to update (each refresh performs one broker login).
          </p>
        </>
      )}
    </div>
  );
}
