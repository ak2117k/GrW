import { LayoutDashboard, Plug } from 'lucide-react';
import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { ConnectAngelOne } from '@/components/broker';
import { useDashboard, pickHeroStats } from '@/hooks/useDashboard';
import { useAuthStore } from '@/stores/auth-store';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]');

export default function UserDashboardPage() {
  const { summary, segments, broker, loading } = useDashboard();
  const hero = pickHeroStats(summary);
  const email = useAuthStore((s) => s.user?.email);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={24} className="text-[var(--color-text-secondary)]" />
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="text-xs text-[var(--color-text-muted)]">{email}</p>
        </div>
      </div>

      {/* Hero */}
      <TiltCard maxTiltDeg={5}>
        <div className="glass-panel depth-card p-6">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">Total P&L</div>
          <div className={clsx('mt-1 text-4xl font-bold tabular-nums', moneyColor(hero.totalPnl))}>
            {loading ? '—' : fmtRs(hero.totalPnl)}
          </div>
          <div className="mt-2 flex gap-6 text-xs text-[var(--color-text-muted)]">
            <span>{(hero.winRate * 100).toFixed(0)}% win rate</span>
            <span>{hero.trades} trades</span>
          </div>
          {!loading && hero.trades === 0 && (
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">No executed trades yet — connect your broker and subscribe to a segment to begin.</p>
          )}
        </div>
      </TiltCard>

      {/* Segment breakdown */}
      {segments.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {segments.map((s) => (
            <TiltCard key={s.segment} maxTiltDeg={5}>
              <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
                <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{s.segment}</div>
                <div className={clsx('mt-1 text-xl font-bold tabular-nums', moneyColor(s.pnl))}>{fmtRs(s.pnl)}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{s.trades} trades</div>
              </div>
            </TiltCard>
          ))}
        </div>
      )}

      {/* Angel One management */}
      <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
        <div className="mb-3 flex items-center gap-2">
          <Plug size={18} className="text-[var(--color-text-secondary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Angel One Account</h2>
          {broker?.connected && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">Connected</span>}
        </div>
        <ConnectAngelOne />
      </div>
    </div>
  );
}
