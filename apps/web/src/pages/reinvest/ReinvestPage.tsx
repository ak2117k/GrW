import { useState } from 'react';
import clsx from 'clsx';
import { useReinvestLots } from '../../hooks/useReinvestLots';
import type { ReinvestLot, ReinvestPool } from '../../services/anand';

const rsFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function fmtRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${rsFmt.format(Math.abs(Math.round(n)))}`;
}
function fmtPlainRs(n: number): string {
  return `₹${rsFmt.format(Math.round(n))}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function moneyColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}
function fmtIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}

function PoolCard({ label, value, signed }: { label: string; value: number; signed?: boolean }) {
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx('mt-1 text-xl font-semibold tabular-nums', signed ? moneyColor(value) : 'text-[var(--color-text-primary)]')}>
        {signed ? fmtRs(value) : fmtPlainRs(value)}
      </div>
    </div>
  );
}

function PoolCards({ pool }: { pool: ReinvestPool }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PoolCard label="Harvested" value={pool.harvestedTotal} />
      <PoolCard label="Deployed (active)" value={pool.deployedActive} />
      <PoolCard label="Idle Balance" value={pool.idleBalance} />
      {/* Realized P&L = P&L booked from CLOSED reinvestment lots only. The
          harvested swing profit is seed capital (shown in Harvested/Deployed),
          not the reinvestment strategy's realized gain — counting it here
          double-counted the swing profit and overstated this tile. */}
      <PoolCard label="Realized P&L" value={pool.realizedPnl} signed />
      <PoolCard label="Unrealized P&L" value={pool.unrealizedPnl} signed />
    </div>
  );
}

const FILTERS = [
  { label: 'Open', value: 'OPEN' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'All', value: undefined },
] as const;

function LotRow({ lot }: { lot: ReinvestLot }) {
  const open = lot.status === 'OPEN';
  const priceShown = open ? lot.currentPrice : lot.exitPrice ?? lot.currentPrice;
  const statusColor: Record<string, string> = {
    OPEN: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };
  return (
    <tr className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]">
      <td className="px-3 py-2 font-mono font-medium">{lot.symbol}</td>
      <td className="px-3 py-2 tabular-nums">{fmtPlainRs(lot.capital)}</td>
      <td className="px-3 py-2 tabular-nums">₹{lot.entryPrice.toFixed(2)}</td>
      <td className={clsx('px-3 py-2 tabular-nums', moneyColor(lot.pnlPct))}>
        ₹{priceShown.toFixed(2)} <span className="text-xs">({fmtPct(lot.pnlPct)})</span>
      </td>
      <td className={clsx('px-3 py-2 font-semibold tabular-nums', moneyColor(lot.pnlRs))}>{fmtRs(lot.pnlRs)}</td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{lot.targetPct}%</td>
      <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[lot.status] ?? 'text-gray-400')}>
        {lot.status.replace('_', ' ')}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstDate(lot.enteredAt)}</td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {lot.exitedAt ? fmtIstDate(lot.exitedAt) : <span className="italic text-gray-500">—</span>}
      </td>
    </tr>
  );
}

export default function ReinvestPage() {
  const [filter, setFilter] = useState<string | undefined>('OPEN');
  const { lots, pool, loading, error } = useReinvestLots(filter);

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div>
        <h1 className="text-2xl font-semibold">Reinvestment</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Swing +10% profits redeployed into the same symbol · capital returns to the pool
        </p>
      </div>

      {pool && <PoolCards pool={pool} />}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={clsx(
              'rounded px-3 py-1 text-sm transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Capital</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Price / Δ%</th>
                <th className="px-3 py-2">P&L ₹</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Opened</th>
                <th className="px-3 py-2">Closed</th>
              </tr>
            </thead>
            <tbody>
              {lots.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No reinvestment lots yet. Lots open when a swing position hits +10%.
                  </td>
                </tr>
              )}
              {lots.map((l) => <LotRow key={l.id} lot={l} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
