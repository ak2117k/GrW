import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/utils/cn';

interface SentimentBadgeProps {
  sentiment: 'bullish' | 'bearish' | 'neutral' | string;
  size?: 'sm' | 'md';
  className?: string;
}

const config: Record<string, { label: string; icon: typeof TrendingUp; colors: string }> = {
  bullish: {
    label: 'Bullish',
    icon: TrendingUp,
    colors: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  },
  bearish: {
    label: 'Bearish',
    icon: TrendingDown,
    colors: 'bg-red-500/15 text-red-400 border-red-500/30',
  },
  neutral: {
    label: 'Neutral',
    icon: Minus,
    colors: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  },
};

export default function SentimentBadge({
  sentiment,
  size = 'md',
  className,
}: SentimentBadgeProps) {
  const cfg = config[sentiment] ?? config.neutral;
  const Icon = cfg.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium leading-none whitespace-nowrap',
        cfg.colors,
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
        className,
      )}
    >
      <Icon size={size === 'sm' ? 10 : 12} />
      {cfg.label}
    </span>
  );
}
