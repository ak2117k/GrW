import { cn } from '@/utils/cn';
import type { SignalConfidence } from '@/types';

interface ConfidenceMeterProps {
  score: number;
  confidence: SignalConfidence;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function getColor(score: number): string {
  if (score >= 90) return 'text-emerald-300';
  if (score >= 75) return 'text-emerald-400';
  if (score >= 60) return 'text-lime-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

function getBarColor(score: number): string {
  if (score >= 90) return 'bg-emerald-300';
  if (score >= 75) return 'bg-emerald-400';
  if (score >= 60) return 'bg-lime-400';
  if (score >= 40) return 'bg-amber-400';
  return 'bg-red-400';
}

function getBarTrackGlow(score: number): string {
  if (score >= 90) return 'shadow-[0_0_8px_rgba(110,231,183,0.3)]';
  if (score >= 75) return 'shadow-[0_0_6px_rgba(52,211,153,0.25)]';
  if (score >= 60) return '';
  return '';
}

const CONFIDENCE_LABELS: Record<string, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  VERY_HIGH: 'Very High',
};

const sizeConfig = {
  sm: { barH: 'h-1.5', textSize: 'text-[10px]', numSize: 'text-xs' },
  md: { barH: 'h-2', textSize: 'text-xs', numSize: 'text-sm' },
  lg: { barH: 'h-2.5', textSize: 'text-xs', numSize: 'text-base' },
};

export default function ConfidenceMeter({
  score,
  confidence,
  size = 'md',
  className,
}: ConfidenceMeterProps) {
  const cfg = sizeConfig[size];

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between">
        <span className={cn('font-medium text-gray-400', cfg.textSize)}>
          Confidence
        </span>
        <div className="flex items-center gap-1.5">
          <span className={cn('font-bold', cfg.numSize, getColor(score))}>
            {score}
          </span>
          <span className={cn('text-gray-500', cfg.textSize)}>
            {CONFIDENCE_LABELS[confidence] ?? confidence}
          </span>
        </div>
      </div>
      <div
        className={cn(
          'w-full overflow-hidden rounded-full bg-gray-700/50',
          cfg.barH,
          getBarTrackGlow(score),
        )}
      >
        <div
          className={cn('h-full rounded-full transition-all duration-500', getBarColor(score))}
          style={{ width: `${Math.min(score, 100)}%` }}
        />
      </div>
    </div>
  );
}
