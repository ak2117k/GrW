import { cn } from '@/utils/cn';

interface GreeksDisplayProps {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  compact?: boolean;
}

const GREEKS_CONFIG = [
  {
    key: 'delta' as const,
    label: '\u0394',
    fullName: 'Delta',
    color: 'text-[var(--color-accent-blue)]',
    tooltip: 'Rate of change of option price per 1-point move in underlying',
  },
  {
    key: 'gamma' as const,
    label: '\u0393',
    fullName: 'Gamma',
    color: 'text-purple-400',
    tooltip: 'Rate of change of Delta per 1-point move in underlying',
  },
  {
    key: 'theta' as const,
    label: '\u0398',
    fullName: 'Theta',
    color: 'text-[var(--color-accent-red)]',
    tooltip: 'Daily time decay — how much value the option loses per day',
  },
  {
    key: 'vega' as const,
    label: '\u039D',
    fullName: 'Vega',
    color: 'text-[var(--color-accent-green)]',
    tooltip: 'Change in option price per 1% change in implied volatility',
  },
];

export default function GreeksDisplay({
  delta,
  gamma,
  theta,
  vega,
  compact = false,
}: GreeksDisplayProps) {
  const values = { delta, gamma, theta, vega };

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {GREEKS_CONFIG.map(({ key, label, color }) => (
          <span key={key} className={cn('text-xs font-mono', color)} title={`${key}: ${values[key]}`}>
            {label} {values[key].toFixed(key === 'delta' ? 2 : key === 'gamma' ? 4 : 2)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {GREEKS_CONFIG.map(({ key, label, fullName, color, tooltip }) => (
        <div
          key={key}
          className="group relative rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2"
          title={tooltip}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--color-text-muted)]">
              {label} {fullName}
            </span>
            <span className={cn('text-sm font-mono font-semibold', color)}>
              {values[key].toFixed(key === 'gamma' ? 4 : 2)}
            </span>
          </div>
          {/* Tooltip on hover */}
          <div className="absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-bg-primary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] shadow-lg ring-1 ring-[var(--color-border-subtle)] group-hover:block">
            {tooltip}
          </div>
        </div>
      ))}
    </div>
  );
}
