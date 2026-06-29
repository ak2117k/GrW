import { cn } from '@/utils/cn';

interface StrategyBadgeProps {
  strategy: string;
  className?: string;
}

const STRATEGY_CONFIG: Record<string, { label: string; color: string }> = {
  'rsi-reversal': {
    label: 'RSI Reversal',
    color: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  },
  'ema-crossover': {
    label: 'EMA Crossover',
    color: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  },
  'vwap-deviation': {
    label: 'VWAP Deviation',
    color: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
};

function formatStrategyName(strategy: string): string {
  return strategy
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function StrategyBadge({ strategy, className }: StrategyBadgeProps) {
  const config = STRATEGY_CONFIG[strategy];
  const label = config?.label ?? formatStrategyName(strategy);
  const color = config?.color ?? 'bg-gray-500/15 text-gray-400 border-gray-500/30';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap',
        color,
        className,
      )}
    >
      {label}
    </span>
  );
}
