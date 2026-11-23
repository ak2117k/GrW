import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface KeywordSentimentCounts {
  bullish: number;
  bearish: number;
  neutral: number;
}

const ROWS = [
  { key: 'bullish', label: 'Bullish', Icon: TrendingUp, text: 'text-emerald-400', bar: 'bg-emerald-400' },
  { key: 'bearish', label: 'Bearish', Icon: TrendingDown, text: 'text-red-400', bar: 'bg-red-400' },
  { key: 'neutral', label: 'Neutral', Icon: Minus, text: 'text-gray-400', bar: 'bg-gray-400' },
] as const;

/**
 * The original keyword-count sentiment bars. Kept only as the fallback when
 * the AI sentiment overview has nothing to show.
 */
export default function KeywordSentimentOverview({
  counts,
  note,
}: {
  counts: KeywordSentimentCounts;
  note?: string;
}) {
  const total = counts.bullish + counts.bearish + counts.neutral;
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
      <h3 className="mb-1 text-sm font-semibold text-[var(--color-text-primary)]">Sentiment Overview</h3>
      <p className="mb-3 text-[10px] text-[var(--color-text-muted)]">
        {note ?? 'Keyword count of loaded articles'}
      </p>
      <div className="space-y-3">
        {ROWS.map(({ key, label, Icon, text, bar }) => (
          <div key={key} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon size={14} className={text} />
              <span className="text-xs text-[var(--color-text-secondary)]">{label}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-700">
                <div
                  className={`h-full rounded-full transition-all ${bar}`}
                  style={{ width: total > 0 ? `${(counts[key] / total) * 100}%` : '0%' }}
                />
              </div>
              <span className={`min-w-[2rem] text-right text-xs font-medium ${text}`}>{counts[key]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
