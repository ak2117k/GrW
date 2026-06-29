import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../../utils/cn';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: number;
  changePercent?: number;
  icon?: ReactNode;
  trend?: 'up' | 'down' | 'flat';
  className?: string;
}

export function StatCard({
  title,
  value,
  change,
  changePercent,
  icon,
  trend,
  className,
}: StatCardProps) {
  const trendColor =
    trend === 'up'
      ? 'text-emerald-400'
      : trend === 'down'
        ? 'text-red-400'
        : 'text-gray-400';

  const TrendIcon =
    trend === 'up'
      ? TrendingUp
      : trend === 'down'
        ? TrendingDown
        : Minus;

  return (
    <div
      className={cn(
        'rounded-lg border border-gray-700/60 bg-gray-800/50 p-4',
        className,
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
          {title}
        </span>
        {icon && <span className="text-gray-500">{icon}</span>}
      </div>

      <div className="text-2xl font-semibold text-gray-100 mb-1">{value}</div>

      {(change !== undefined || changePercent !== undefined) && (
        <div className={cn('flex items-center gap-1 text-xs', trendColor)}>
          <TrendIcon size={14} />
          {change !== undefined && (
            <span>
              {change >= 0 ? '+' : ''}
              {change.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          )}
          {changePercent !== undefined && (
            <span>
              ({changePercent >= 0 ? '+' : ''}
              {changePercent.toFixed(2)}%)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
