import { cn } from '@/utils/cn';
import { formatINR } from '@td/shared';

interface RiskRewardBarProps {
  riskRewardRatio: number;
  expectedProfit: number;
  expectedLoss: number;
  className?: string;
}

export default function RiskRewardBar({
  riskRewardRatio,
  expectedProfit,
  expectedLoss,
  className,
}: RiskRewardBarProps) {
  // Calculate proportions for the bar
  const totalWeight = 1 + riskRewardRatio;
  const riskPct = (1 / totalWeight) * 100;
  const rewardPct = (riskRewardRatio / totalWeight) * 100;

  const ratioLabel = `1:${riskRewardRatio.toFixed(1)}`;

  const isGood = riskRewardRatio >= 2;
  const isOk = riskRewardRatio >= 1;

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-red-400">Risk {formatINR(Math.abs(expectedLoss))}</span>
        <span
          className={cn(
            'font-semibold',
            isGood ? 'text-emerald-400' : isOk ? 'text-amber-400' : 'text-red-400',
          )}
        >
          R:R {ratioLabel}
        </span>
        <span className="text-emerald-400">Reward {formatINR(expectedProfit)}</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full transition-all',
            riskRewardRatio < 1
              ? 'bg-red-500'
              : riskRewardRatio < 2
                ? 'bg-red-400'
                : 'bg-red-400/70',
          )}
          style={{ width: `${riskPct}%` }}
        />
        <div
          className={cn(
            'h-full transition-all',
            isGood ? 'bg-emerald-500' : isOk ? 'bg-emerald-400/70' : 'bg-emerald-400/50',
          )}
          style={{ width: `${rewardPct}%` }}
        />
      </div>
    </div>
  );
}
