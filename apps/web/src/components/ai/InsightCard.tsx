import { Lightbulb, AlertTriangle, BarChart3, FileText } from 'lucide-react';
import type { AIInsight } from '@/types';
import { cn } from '@/utils/cn';

interface InsightCardProps {
  insight: AIInsight;
}

const ICON_MAP = {
  suggestion: { icon: Lightbulb, color: 'text-[var(--color-accent-yellow)]', bg: 'bg-[var(--color-accent-yellow)]/10' },
  warning: { icon: AlertTriangle, color: 'text-[var(--color-accent-red)]', bg: 'bg-[var(--color-accent-red)]/10' },
  analysis: { icon: BarChart3, color: 'text-[var(--color-accent-blue)]', bg: 'bg-[var(--color-accent-blue)]/10' },
  report: { icon: FileText, color: 'text-purple-400', bg: 'bg-purple-400/10' },
} as const;

export function InsightCard({ insight }: InsightCardProps) {
  const config = ICON_MAP[insight.type] ?? ICON_MAP.analysis;
  const Icon = config.icon;

  const time = new Date(insight.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 hover:border-[var(--color-border-default)] transition-colors">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            config.bg,
          )}
        >
          <Icon size={16} className={config.color} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {insight.title}
            </h4>
            {insight.actionable && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-accent-blue)]/15 text-[var(--color-accent-blue)] shrink-0">
                Actionable
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed line-clamp-3">
            {insight.content}
          </p>
          <span className="text-[10px] text-[var(--color-text-muted)] mt-1.5 inline-block">
            {time}
          </span>
        </div>
      </div>
    </div>
  );
}
