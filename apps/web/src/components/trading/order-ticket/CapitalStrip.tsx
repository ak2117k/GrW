import { cn } from '@/utils/cn';

export interface CapitalStripProps {
  orderValue: number;
  capitalLimit: number;
  capitalDeployed: number;
  maxAffordable: number;
}

const inr = (n: number) =>
  n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export default function CapitalStrip({
  orderValue,
  capitalLimit,
  capitalDeployed,
  maxAffordable,
}: CapitalStripProps) {
  const hasLimit = capitalLimit > 0;
  const remaining = Math.max(0, capitalLimit - capitalDeployed);

  // Projected usage including the pending order.
  const usedFrac = hasLimit ? (capitalDeployed + orderValue) / capitalLimit : 0;
  const usedPct = usedFrac * 100;
  const orderPctOfLimit = hasLimit ? (orderValue / capitalLimit) * 100 : 0;

  const barColor = !hasLimit
    ? 'bg-gray-600'
    : usedFrac >= 1
      ? 'bg-red-500'
      : usedFrac > 0.8
        ? 'bg-amber-500'
        : 'bg-blue-500';

  return (
    <div className="rounded-md border border-gray-700/50 bg-gray-800/80 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Order value</span>
        <span className="font-medium text-[var(--color-text-primary)]">{inr(orderValue)}</span>
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-500">
          {hasLimit ? (
            <>
              Uses {orderPctOfLimit.toFixed(0)}% of {inr(capitalLimit)}
            </>
          ) : (
            'No capital limit set'
          )}
        </span>
        <span className="text-gray-400">Remaining {inr(remaining)}</span>
      </div>

      {/* Projected capital usage bar */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
        <div
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
        />
      </div>

      <div className="text-[11px] text-gray-500">
        Max affordable:{' '}
        <span className="font-medium text-gray-300">{maxAffordable.toLocaleString('en-IN')}</span>{' '}
        shares
      </div>
    </div>
  );
}
