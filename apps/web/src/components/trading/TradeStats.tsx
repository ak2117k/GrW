import { TrendingUp, TrendingDown, Target, BarChart3, Award, AlertTriangle, Activity, Percent } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { Trade } from '@/types';
import { formatINR } from '@td/shared';

interface TradeStatsProps {
  trades: Trade[];
  className?: string;
}

interface MiniStat {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}

export default function TradeStats({ trades, className }: TradeStatsProps) {
  const totalTrades = trades.length;

  const closedTrades = trades.filter(
    (t) => t.status === 'CLOSED' || t.status === 'FILLED',
  );
  const winners = closedTrades.filter((t) => t.pnl > 0);
  const losers = closedTrades.filter((t) => t.pnl < 0);

  const winRate =
    closedTrades.length > 0
      ? (winners.length / closedTrades.length) * 100
      : 0;

  const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);

  const avgWin =
    winners.length > 0
      ? winners.reduce((sum, t) => sum + t.pnl, 0) / winners.length
      : 0;

  const avgLoss =
    losers.length > 0
      ? losers.reduce((sum, t) => sum + t.pnl, 0) / losers.length
      : 0;

  const bestTrade =
    closedTrades.length > 0
      ? Math.max(...closedTrades.map((t) => t.pnl))
      : 0;

  const worstTrade =
    closedTrades.length > 0
      ? Math.min(...closedTrades.map((t) => t.pnl))
      : 0;

  const grossProfit = winners.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const stats: MiniStat[] = [
    {
      label: 'Total Trades',
      value: totalTrades.toString(),
      icon: <BarChart3 size={14} />,
      color: 'text-blue-400',
    },
    {
      label: 'Win Rate',
      value: `${winRate.toFixed(1)}%`,
      icon: <Percent size={14} />,
      color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400',
    },
    {
      label: 'Total P&L',
      value: formatINR(totalPnl),
      icon: totalPnl >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />,
      color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400',
    },
    {
      label: 'Avg Win',
      value: formatINR(avgWin),
      icon: <Award size={14} />,
      color: 'text-emerald-400',
    },
    {
      label: 'Avg Loss',
      value: formatINR(avgLoss),
      icon: <AlertTriangle size={14} />,
      color: 'text-red-400',
    },
    {
      label: 'Best Trade',
      value: formatINR(bestTrade),
      icon: <Target size={14} />,
      color: 'text-emerald-400',
    },
    {
      label: 'Worst Trade',
      value: formatINR(worstTrade),
      icon: <TrendingDown size={14} />,
      color: 'text-red-400',
    },
    {
      label: 'Profit Factor',
      value: profitFactor === Infinity ? '--' : profitFactor.toFixed(2),
      icon: <Activity size={14} />,
      color: profitFactor >= 1 ? 'text-emerald-400' : 'text-red-400',
    },
  ];

  return (
    <div
      className={cn(
        'grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3',
        className,
      )}
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-lg border border-gray-700/60 bg-gray-800/50 px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span className={cn('opacity-70', stat.color)}>{stat.icon}</span>
            <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide truncate">
              {stat.label}
            </span>
          </div>
          <div className={cn('text-sm font-semibold', stat.color)}>
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
