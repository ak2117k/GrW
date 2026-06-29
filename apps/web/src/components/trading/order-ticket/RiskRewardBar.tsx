import { cn } from '@/utils/cn';
import { AlertTriangle } from 'lucide-react';

export interface RiskRewardBarProps {
  riskAmt: number;
  rewardAmt: number;
  rr: number | null;
  slPct: number | null;
  tgtPct: number | null;
}

const inr = (n: number) =>
  n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export default function RiskRewardBar({
  riskAmt,
  rewardAmt,
  rr,
  slPct,
  tgtPct,
}: RiskRewardBarProps) {
  const poorRR = rr != null && rr < 1;

  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 space-y-2',
        poorRR
          ? 'border-amber-500/30 bg-amber-500/10'
          : 'border-gray-700/50 bg-gray-800/80',
      )}
    >
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Risk / Reward</span>
        <span className="font-semibold text-[var(--color-text-primary)]">
          {rr != null ? `1 : ${rr.toFixed(1)}` : '—'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex flex-col">
          <span className="text-gray-500">Risk</span>
          <span className="font-medium text-red-400">{inr(riskAmt)}</span>
          {slPct != null && (
            <span className="text-gray-500">SL -{Math.abs(slPct).toFixed(1)}%</span>
          )}
        </div>
        <div className="flex flex-col text-right">
          <span className="text-gray-500">Reward</span>
          <span className="font-medium text-emerald-400">{inr(rewardAmt)}</span>
          {tgtPct != null && (
            <span className="text-gray-500">TGT +{Math.abs(tgtPct).toFixed(1)}%</span>
          )}
        </div>
      </div>

      {poorRR && (
        <div className="flex items-center gap-1 text-[11px] text-amber-400">
          <AlertTriangle size={12} />
          Reward is smaller than risk
        </div>
      )}
    </div>
  );
}
