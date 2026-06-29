import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../../utils/cn';

interface PnLDisplayProps {
  // Accept null/undefined for open trades whose realized P&L isn't known
  // until close — render a dash in those cases instead of a misleading ₹0.00.
  value: number | null | undefined;
  percent?: number | null;
  size?: 'sm' | 'md' | 'lg';
  showSign?: boolean;
  className?: string;
}

const sizeStyles = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg font-semibold',
};

const iconSizes = { sm: 12, md: 14, lg: 18 };

export function PnLDisplay({
  value,
  percent,
  size = 'md',
  showSign = true,
  className,
}: PnLDisplayProps) {
  if (value === null || value === undefined) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-gray-500',
          sizeStyles[size],
          className,
        )}
      >
        --
      </span>
    );
  }

  const isPositive = value > 0;
  const isNegative = value < 0;
  const colorClass = isPositive
    ? 'text-emerald-400'
    : isNegative
      ? 'text-red-400'
      : 'text-gray-400';

  const Icon = isPositive ? TrendingUp : isNegative ? TrendingDown : Minus;
  const sign = showSign && isPositive ? '+' : '';

  const formatted = `${sign}\u20B9${Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        sizeStyles[size],
        colorClass,
        className,
      )}
    >
      <Icon size={iconSizes[size]} />
      <span>{formatted}</span>
      {percent !== undefined && percent !== null && (
        <span className="opacity-75">
          ({sign}{percent.toFixed(2)}%)
        </span>
      )}
    </span>
  );
}
