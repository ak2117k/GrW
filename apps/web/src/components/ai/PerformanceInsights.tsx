import { TrendingUp, Target, Activity, Zap } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { TradingSuggestion } from '@/stores/advisor-store';

interface PerformanceInsightsProps {
  suggestions: TradingSuggestion[];
}

const PRIORITY_STYLES = {
  high: {
    border: 'border-[var(--color-accent-red)]/30',
    bg: 'bg-[var(--color-accent-red)]/5',
    badge: 'bg-[var(--color-accent-red)]/15 text-[var(--color-accent-red)]',
  },
  medium: {
    border: 'border-[var(--color-accent-yellow)]/30',
    bg: 'bg-[var(--color-accent-yellow)]/5',
    badge: 'bg-[var(--color-accent-yellow)]/15 text-[var(--color-accent-yellow)]',
  },
  low: {
    border: 'border-[var(--color-border-subtle)]',
    bg: 'bg-[var(--color-bg-card)]',
    badge: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]',
  },
} as const;

const CATEGORY_ICONS = {
  strategy: Target,
  risk: Activity,
  timing: Zap,
  general: TrendingUp,
} as const;

export function PerformanceInsights({ suggestions }: PerformanceInsightsProps) {
  if (suggestions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-6 text-center">
        <Activity size={24} className="mx-auto mb-2 text-[var(--color-text-muted)]" />
        <p className="text-xs text-[var(--color-text-muted)]">
          Trade more to get personalized performance insights.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
        <Zap size={14} className="text-[var(--color-accent-yellow)]" />
        Trading Suggestions
      </h3>

      {suggestions.map((suggestion) => {
        const styles = PRIORITY_STYLES[suggestion.priority] ?? PRIORITY_STYLES.low;
        const IconComp =
          CATEGORY_ICONS[suggestion.category as keyof typeof CATEGORY_ICONS] ??
          CATEGORY_ICONS.general;

        return (
          <div
            key={suggestion.id}
            className={cn(
              'rounded-lg border p-3 transition-colors',
              styles.border,
              styles.bg,
            )}
          >
            <div className="flex items-start gap-2.5">
              <IconComp size={14} className="text-[var(--color-text-muted)] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
                    {suggestion.title}
                  </span>
                  <span
                    className={cn(
                      'text-[9px] font-medium px-1.5 py-0.5 rounded uppercase shrink-0',
                      styles.badge,
                    )}
                  >
                    {suggestion.priority}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed line-clamp-2">
                  {suggestion.description}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
