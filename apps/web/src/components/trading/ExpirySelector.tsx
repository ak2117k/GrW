import { cn } from '@/utils/cn';

interface ExpirySelectorProps {
  expiries: string[];
  selected: string;
  onChange: (expiry: string) => void;
}

function formatExpiry(dateStr: string): { label: string; isMonthly: boolean } {
  const date = new Date(dateStr + 'T00:00:00');
  const day = date.getDate();
  const month = date.toLocaleString('en-IN', { month: 'short' });

  // Monthly expiry is typically the last Thursday of the month
  // Approximate: if date is >= 25th, consider it monthly
  const isMonthly = day >= 25;

  return {
    label: `${day} ${month}`,
    isMonthly,
  };
}

export default function ExpirySelector({
  expiries,
  selected,
  onChange,
}: ExpirySelectorProps) {
  if (expiries.length === 0) {
    return (
      <div className="text-xs text-[var(--color-text-muted)]">
        No expiries available
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
      {expiries.map((expiry) => {
        const { label, isMonthly } = formatExpiry(expiry);
        const isActive = expiry === selected;

        return (
          <button
            key={expiry}
            onClick={() => onChange(expiry)}
            className={cn(
              'flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all',
              isActive
                ? 'bg-[var(--color-accent-blue)] text-white shadow-sm'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-card)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {label}
            {isMonthly && (
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[10px] font-bold leading-none',
                  isActive
                    ? 'bg-white/20 text-white'
                    : 'bg-[var(--color-accent-yellow)]/20 text-[var(--color-accent-yellow)]',
                )}
              >
                M
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
