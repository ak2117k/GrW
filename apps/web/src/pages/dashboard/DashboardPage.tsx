import type { ReactNode } from 'react';
import {
  LayoutDashboard,
  TrendingUp,
  TrendingDown,
  Activity,
  Target,
  BarChart3,
  LineChart,
  ArrowRight,
  RefreshCw,
  Bot,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { StatCard, PnLDisplay } from '@/components/common';
import { EquityCurve, PnLChart, WinRateDonut, SegmentBreakdown } from '@/components/charts';
import { closedByLabel, getLiveDashboard, lastN, type LiveTradeRow } from '@/services/livePortfolio';
import { cn } from '@/utils/cn';

const REFRESH_MS = 30_000;
const DAILY_BARS = 30;

function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

const trendOf = (n: number): 'up' | 'down' | 'flat' => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

function Panel({ title, icon, right, className, children }: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5', className)}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function NoLiveData({ text }: { text: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-1 text-center text-sm text-[var(--color-text-muted)]">
      <span>No live data yet</span>
      <span className="text-xs">{text}</span>
    </div>
  );
}

/**
 * Owner dashboard — LIVE (real-money) trading only. Every widget reads
 * GET /portfolio/live/dashboard: broker positions/holdings (manual at the broker,
 * model/auto-trade) with AI-agent / manual / trigger exit attribution. Realised
 * P&L is bucketed by IST exit day. Paper trades are in the Journal's Paper tab.
 */
export default function DashboardPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portfolio', 'live', 'dashboard'], queryFn: getLiveDashboard, refetchInterval: REFRESH_MS });
  const d = q.data;
  const s = d?.summary;

  const todayPnl = s?.todayRealisedPnl ?? 0;
  const realised = s?.realisedPnl ?? 0;
  const unrealised = s?.unrealisedPnl ?? 0;
  const winRate = s?.winRate ?? 0;
  const closedTrades = s?.closedTrades ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={24} className="text-[var(--color-accent-blue)]" />
          <div>
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
            <p className="text-xs text-[var(--color-text-muted)]">Live trades only: your broker positions, AI-agent exits and model trades</p>
          </div>
        </div>
        {q.isFetching && <RefreshCw size={16} className="animate-spin text-[var(--color-text-muted)]" />}
      </div>

      {q.isError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
          Could not load live trade data. It will retry automatically.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Today's realised P&L"
          value={formatINR(todayPnl)}
          icon={todayPnl >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          trend={trendOf(todayPnl)}
        />
        <StatCard
          title="Total realised P&L"
          value={formatINR(realised)}
          icon={realised >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          trend={trendOf(realised)}
        />
        <StatCard
          title={`Open positions (${s?.openPositions ?? 0})`}
          value={formatINR(unrealised)}
          icon={<Activity size={16} />}
          trend={trendOf(unrealised)}
        />
        <StatCard
          title={`Win rate (${closedTrades} closed)`}
          value={`${winRate.toFixed(1)}%`}
          icon={<Target size={16} />}
          trend={closedTrades === 0 ? 'flat' : winRate >= 50 ? 'up' : 'down'}
        />
      </div>

      <Panel
        title="Equity Curve (realised)"
        icon={<LineChart size={16} className="text-[var(--color-accent-green)]" />}
        right={s && s.maxDrawdown > 0 ? <span className="text-xs text-[var(--color-text-muted)]">Max drawdown {formatINR(s.maxDrawdown)}</span> : null}
      >
        {d && d.equityCurve.length > 0 ? (
          <EquityCurve data={d.equityCurve} />
        ) : (
          <NoLiveData text="The curve starts at your first closed real trade." />
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Panel title="Daily P&L (IST)" icon={<BarChart3 size={16} className="text-[var(--color-accent-blue)]" />} className="lg:col-span-3">
          {d && d.dailyPnl.length > 0 ? (
            <PnLChart data={lastN(d.dailyPnl, DAILY_BARS)} />
          ) : (
            <NoLiveData text="Realised P&L appears here by exit day once a real trade closes." />
          )}
        </Panel>
        <Panel title="Win / Loss" icon={<Target size={16} className="text-[var(--color-accent-yellow)]" />} className="lg:col-span-2">
          {s && s.wins + s.losses > 0 ? (
            <WinRateDonut wins={s.wins} losses={s.losses} />
          ) : (
            <NoLiveData text="No closed real trades yet." />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Segment Breakdown" icon={<BarChart3 size={16} className="text-[var(--color-accent-blue)]" />}>
          {d && d.segments.length > 0 ? (
            <SegmentBreakdown data={d.segments} />
          ) : (
            <NoLiveData text="Realised P&L per segment appears once a real trade closes." />
          )}
        </Panel>

        <Panel title="Who closed" icon={<Bot size={16} className="text-[var(--color-accent-blue)]" />}>
          {d && d.closedBy.length > 0 ? (
            <div className="space-y-2">
              {d.closedBy.map((c) => (
                <div key={c.closedBy} className="flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--color-text-primary)]">{closedByLabel(c.closedBy)}</p>
                    <p className="text-[10px] text-[var(--color-text-muted)]">{c.trades} trade{c.trades === 1 ? '' : 's'}</p>
                  </div>
                  <PnLDisplay value={c.pnl} size="sm" />
                </div>
              ))}
            </div>
          ) : (
            <NoLiveData text="Closed trades are split by AI agent, manual, price trigger and model." />
          )}
        </Panel>
      </div>

      <Panel
        title="Recent live trades"
        right={
          <button onClick={() => navigate('/journal')} className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent-blue)]">
            Journal <ArrowRight size={12} />
          </button>
        }
      >
        {d && d.recent.length > 0 ? (
          <div className="space-y-2">
            {d.recent.map((t) => <RecentRow key={`${t.origin}-${t.id}`} t={t} />)}
          </div>
        ) : (
          <NoLiveData text="Your broker positions show here once the tracker picks them up." />
        )}
      </Panel>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => navigate('/signals')}
          className="flex items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-4 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
        >
          View Signals
          <ArrowRight size={14} />
        </button>
        <button
          onClick={() => navigate('/charts')}
          className="flex items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-4 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-green)] hover:text-[var(--color-accent-green)]"
        >
          Go to Charts
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function RecentRow({ t }: { t: LiveTradeRow }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
            t.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
          )}
        >
          {t.side}
        </span>
        <div>
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t.symbol}</p>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            {t.segment} &middot; {t.status === 'OPEN' ? 'Open' : `Closed by ${closedByLabel(t.closedBy)}`}
            {t.openedBy === 'MODEL' ? ' · model entry' : ''}
          </p>
        </div>
      </div>
      <div className="text-right">
        <PnLDisplay value={t.pnl} size="sm" />
        <p className="text-[10px] text-[var(--color-text-muted)]">Qty: {t.qty}</p>
      </div>
    </div>
  );
}
