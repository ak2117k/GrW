import { cn } from '@/utils/cn';

interface StrikeSelectorProps {
  range: number;
  onChange: (range: number) => void;
  atmStrike: number;
}

const RANGE_OPTIONS = [5, 10, 15, 20, 0]; // 0 = All
const RANGE_LABELS: Record<number, string> = {
  5: 'ATM ± 5',
  10: 'ATM ± 10',
  15: 'ATM ± 15',
  20: 'ATM ± 20',
  0: 'All',
};

export default function StrikeSelector({
  range,
  onChange,
  atmStrike,
}: StrikeSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--color-text-muted)]">Strikes:</span>
      <div className="flex items-center gap-1">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium transition-all',
              range === opt
                ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)] ring-1 ring-[var(--color-accent-blue)]/40'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            {RANGE_LABELS[opt]}
          </button>
        ))}
      </div>
      {atmStrike > 0 && (
        <span className="ml-2 text-xs text-[var(--color-text-muted)]">
          ATM: <span className="font-semibold text-[var(--color-accent-yellow)]">{atmStrike.toLocaleString()}</span>
        </span>
      )}
    </div>
  );
}
