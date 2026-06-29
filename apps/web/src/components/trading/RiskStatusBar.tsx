import { cn } from '@/utils/cn';
import { useTradeStore } from '@/stores/trade-store';
import { AlertTriangle } from 'lucide-react';

function RiskMeter({
  label,
  used,
  limit,
  format = 'currency',
}: {
  label: string;
  used: number;
  limit: number;
  format?: 'currency' | 'count';
}) {
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  const isWarning = percent >= 80;
  const isCritical = percent >= 95;

  const formatVal = (val: number) => {
    if (format === 'count') return val.toString();
    return val.toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    });
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          {isWarning && <AlertTriangle size={12} className="text-amber-400 shrink-0" />}
          <span className="text-xs font-medium text-gray-400 truncate">{label}</span>
        </div>
        <span className="text-xs text-gray-300 whitespace-nowrap">
          {formatVal(used)} / {formatVal(limit)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-700/50 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            isCritical
              ? 'bg-red-500'
              : isWarning
                ? 'bg-amber-500'
                : 'bg-emerald-500',
          )}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function RiskStatusBar() {
  const riskStatus = useTradeStore((s) => s.riskStatus);

  return (
    <div className="flex items-center gap-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-5 py-3">
      <RiskMeter
        label="Daily Loss"
        used={riskStatus.dailyLossUsed}
        limit={riskStatus.dailyLossLimit}
        format="currency"
      />
      <div className="w-px h-8 bg-[var(--color-border-subtle)]" />
      <RiskMeter
        label="Positions"
        used={riskStatus.positionsUsed}
        limit={riskStatus.positionsLimit}
        format="count"
      />
      <div className="w-px h-8 bg-[var(--color-border-subtle)]" />
      <RiskMeter
        label="Capital Deployed"
        used={riskStatus.capitalDeployed}
        limit={riskStatus.capitalLimit}
        format="currency"
      />
    </div>
  );
}
