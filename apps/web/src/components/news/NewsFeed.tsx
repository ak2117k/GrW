import { useRef, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { LoadingSkeleton } from '@/components/common';
import NewsCard from './NewsCard';
import type { NewsItem } from '@/types';

interface NewsFeedProps {
  articles: NewsItem[];
  isLoading: boolean;
  total: number;
  onLoadMore: () => void;
  className?: string;
}

export default function NewsFeed({
  articles,
  isLoading,
  total,
  onLoadMore,
  className,
}: NewsFeedProps) {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const hasMore = articles.length < total;

  // Infinite scroll sentinel
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!node || !hasMore || isLoading) return;

      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            onLoadMore();
          }
        },
        { rootMargin: '200px' },
      );
      observerRef.current.observe(node);
    },
    [hasMore, isLoading, onLoadMore],
  );

  if (isLoading && articles.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <LoadingSkeleton variant="card" count={5} className="h-28" />
      </div>
    );
  }

  if (!isLoading && articles.length === 0) {
    return (
      <div className={cn('rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-8 text-center', className)}>
        <p className="text-sm text-[var(--color-text-muted)]">
          No news articles found. Try adjusting your filters or refresh.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3 overflow-y-auto', className)}>
      {articles.map((article) => (
        <NewsCard key={article.id} article={article} />
      ))}

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-4">
          {isLoading && <Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" />}
        </div>
      )}

      {!hasMore && articles.length > 0 && (
        <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">
          All {total} articles loaded
        </p>
      )}
    </div>
  );
}
