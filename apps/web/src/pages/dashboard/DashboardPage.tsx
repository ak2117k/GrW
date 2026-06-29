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
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatCard } from '@/components/common';
import { PnLDisplay } from '@/components/common';
import { EquityCurve, PnLChart, WinRateDonut, SegmentBreakdown } from '@/components/charts';
import { usePortfolio } from '@/hooks/usePortfolio';
import { cn } from '@/utils/cn';

function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const {
    summary,
    equityCurve,
    dailyPnl,
    segmentBreakdown,
    recentTrades,
    isLoading,
  } = usePortfolio();

  const todayPnl = summary?.todayPnl ?? 0;
  const totalPnl = summary?.totalPnl ?? 0;
  const winRate = summary?.winRate ?? 0;
  const openPositions = summary?.openPositions ?? 0;
  const totalTrades = summary?.totalTrades ?? 0;

  // Compute wins / losses from winRate and totalTrades
  const wins = totalTrades > 0 ? Math.round((winRate / 100) * totalTrades) : 0;
  const losses = totalTrades - wins;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={24} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
        </div>
        {isLoading && (
          <RefreshCw size={16} className="animate-spin text-[var(--color-text-muted)]" />
        )}
      </div>

      {/* Stat Cards Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Today's P&L"
          value={formatINR(todayPnl)}
          icon={todayPnl >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          trend={todayPnl > 0 ? 'up' : todayPnl < 0 ? 'down' : 'flat'}
        />
        <StatCard
          title="Total P&L"
          value={formatINR(totalPnl)}
          icon={totalPnl >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          trend={totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : 'flat'}
        />
        <StatCard
          title="Win Rate"
          value={`${winRate.toFixed(1)}%`}
          icon={<Target size={16} />}
          trend={winRate >= 50 ? 'up' : winRate > 0 ? 'down' : 'flat'}
        />
        <StatCard
          title="Active Positions"
          value={String(openPositions)}
          icon={<Activity size={16} />}
          trend="flat"
        />
      </div>

      {/* Equity Curve — Full Width */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
        <div className="mb-4 flex items-center gap-2">
          <LineChart size={16} className="text-[var(--color-accent-green)]" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            Equity Curve
          </h2>
        </div>
        <EquityCurve data={equityCurve} />
      </div>

      {/* Middle Row — Daily P&L + Win Rate */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 lg:col-span-3">
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 size={16} className="text-[var(--color-accent-blue)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
              Daily P&L
            </h2>
          </div>
          <PnLChart data={dailyPnl} />
        </div>
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 lg:col-span-2">
          <div className="mb-4 flex items-center gap-2">
            <Target size={16} className="text-[var(--color-accent-yellow)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
              Win / Loss
            </h2>
          </div>
          <WinRateDonut wins={wins} losses={losses} />
        </div>
      </div>

      {/* Bottom Row — Segment Breakdown + Recent Trades */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 size={16} className="text-[var(--color-accent-blue)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
              Segment Breakdown
            </h2>
          </div>
          <SegmentBreakdown data={segmentBreakdown} />
        </div>

        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
              Recent Trades
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">Last 5</span>
          </div>

          {recentTrades.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-[var(--color-text-muted)]">
              No recent trades
            </div>
          ) : (
            <div className="space-y-2">
              {recentTrades.map((trade) => (
                <div
                  key={trade.id}
                  className="flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                        trade.side === 'BUY'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-red-500/15 text-red-400',
                      )}
                    >
                      {trade.side}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-[var(--color-text-primary)]">
                        {trade.instrument?.symbol ?? 'Unknown'}
                      </p>
                      <p className="text-[10px] text-[var(--color-text-muted)]">
                        {trade.strategy ?? 'Manual'} &middot; {trade.instrument?.segment ?? ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    {trade.pnl !== null ? (
                      <PnLDisplay value={trade.pnl} size="sm" />
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">--</span>
                    )}
                    <p className="text-[10px] text-[var(--color-text-muted)]">
                      Qty: {trade.quantity}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
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
