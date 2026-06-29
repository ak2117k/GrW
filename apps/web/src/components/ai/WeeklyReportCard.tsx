import { Calendar, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { WeeklyReport } from '@/stores/advisor-store';

interface WeeklyReportCardProps {
  report: WeeklyReport;
  onViewFull?: (id: string) => void;
}

export function WeeklyReportCard({ report, onViewFull }: WeeklyReportCardProps) {
  const isPositive = report.overallScore >= 55;
  const weekStartDate = new Date(report.weekStart).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
  const weekEndDate = new Date(report.weekEnd).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });

  // Extract P&L from summary if present (pattern: "+1234.56" or "-1234.56")
  const pnlMatch = report.summary.match(/P&L:\s*([+-]?[\d,.]+)/);
  const pnlText = pnlMatch ? pnlMatch[1] : null;

  // Extract win rate from summary if present
  const wrMatch = report.summary.match(/Win Rate:\s*(\d+)%/);
  const winRateText = wrMatch ? `${wrMatch[1]}%` : null;

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-colors',
        isPositive
          ? 'border-[var(--color-accent-green)]/30 bg-[var(--color-accent-green)]/5'
          : 'border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-[var(--color-text-muted)]" />
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
            {weekStartDate} - {weekEndDate}
          </span>
        </div>
        <div
          className={cn(
            'flex items-center gap-1 text-xs font-semibold',
            isPositive ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]',
          )}
        >
          {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {report.overallScore}/100
        </div>
      </div>

      {/* Quick stats */}
      <div className="flex gap-4 mb-3">
        {pnlText && (
          <div>
            <div className="text-[10px] text-[var(--color-text-muted)] uppercase">P&L</div>
            <div
              className={cn(
                'text-sm font-semibold',
                pnlText.startsWith('-')
                  ? 'text-[var(--color-accent-red)]'
                  : 'text-[var(--color-accent-green)]',
              )}
            >
              {pnlText}
            </div>
          </div>
        )}
        {winRateText && (
          <div>
            <div className="text-[10px] text-[var(--color-text-muted)] uppercase">Win Rate</div>
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">
              {winRateText}
            </div>
          </div>
        )}
      </div>

      {/* Key insight (first strength or recommendation) */}
      <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed line-clamp-2 mb-3">
        {report.strengths[0] ?? report.recommendations[0] ?? report.summary.slice(0, 120)}
      </p>

      {/* View full report */}
      {onViewFull && (
        <button
          onClick={() => onViewFull(report.id)}
          className="flex items-center gap-1 text-xs text-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]/80 transition-colors"
        >
          View Full Report <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
