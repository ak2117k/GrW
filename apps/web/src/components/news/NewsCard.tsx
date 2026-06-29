import { ExternalLink, Clock } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/common';
import SentimentBadge from './SentimentBadge';
import type { NewsItem } from '@/types';

interface NewsCardProps {
  article: NewsItem;
  className?: string;
}

function timeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
}

const categoryVariant: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = {
  indian: 'info',
  global: 'warning',
  sector: 'success',
  company: 'neutral',
};

export default function NewsCard({ article, className }: NewsCardProps) {
  return (
    <div
      className={cn(
        'group rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4',
        'hover:border-[var(--color-border-default)] transition-colors',
        className,
      )}
    >
      {/* Title */}
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-2 text-sm font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent-blue)] transition-colors leading-snug"
      >
        <span className="flex-1 line-clamp-2">{article.title}</span>
        <ExternalLink
          size={14}
          className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-text-muted)]"
        />
      </a>

      {/* Summary */}
      {article.summary && (
        <p className="mt-2 text-xs text-[var(--color-text-secondary)] line-clamp-2 leading-relaxed">
          {article.summary}
        </p>
      )}

      {/* Badges row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge
          label={article.source}
          variant="info"
          size="sm"
        />
        <SentimentBadge sentiment={article.sentiment} size="sm" />
        <Badge
          label={article.category}
          variant={categoryVariant[article.category] ?? 'neutral'}
          size="sm"
        />
      </div>

      {/* Related symbols + time */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {article.relatedSymbols.slice(0, 5).map((symbol) => (
            <a
              key={symbol}
              href={`/charts?symbol=${symbol}`}
              className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-mono font-medium text-[var(--color-accent-blue)] hover:bg-[var(--color-accent-blue)]/10 transition-colors"
            >
              {symbol}
            </a>
          ))}
        </div>

        <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
          <Clock size={10} />
          {timeAgo(article.publishedAt)}
        </span>
      </div>
    </div>
  );
}
