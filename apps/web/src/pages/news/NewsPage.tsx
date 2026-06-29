import { useMemo } from 'react';
import { Newspaper, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useNews } from '@/hooks/useNews';
import { NewsFeed, NewsFilters } from '@/components/news';
import AIInsightCard from '@/components/ai/AIInsightCard';
import { cn } from '@/utils/cn';

function formatTime(date: Date | null): string {
  if (!date) return 'Never';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function NewsPage() {
  const {
    articles,
    filters,
    isLoading,
    isRefreshing,
    total,
    lastUpdated,
    sentimentCounts,
    trendingSymbols,
    sources,
    refreshNews,
    loadMore,
    updateFilters,
  } = useNews();

  const totalSentiment = sentimentCounts.bullish + sentimentCounts.bearish + sentimentCounts.neutral;

  // Batch-analysis context for the feed: send the top 20 filtered articles
  // to Claude (via MCP /insights pipeline) so the analysis sees a full
  // cross-section of today's headlines rather than one article at a time.
  // contextKey hashes the article IDs so re-renders with the same feed share
  // a completed insight (idempotent on the backend); a feed refresh that
  // brings in new top articles produces a new key → fresh analysis.
  const newsInsight = useMemo(() => {
    const top = articles.slice(0, 20);
    const contextKey = top.length > 0
      ? top.map((a) => a.id).join(',').slice(0, 200)
      : 'empty';
    const contextData = {
      filter: filters.source ?? 'all',
      articleCount: top.length,
      capturedAt: new Date().toISOString(),
      sentimentCounts,
      articles: top.map((a) => ({
        title: a.title,
        summary: (a.summary ?? '').slice(0, 400),
        source: a.source,
        category: a.category,
        relatedSymbols: a.relatedSymbols,
        publishedAt: a.publishedAt,
        // The current keyword-based label — Claude can override or agree.
        keywordSentiment: a.sentiment,
      })),
    };
    return { contextKey, contextData, hasArticles: top.length > 0 };
  }, [articles, filters.source, sentimentCounts]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Newspaper size={24} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Market News
          </h1>
          {total > 0 && (
            <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-text-secondary)]">
              {total} articles
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            Updated: {formatTime(lastUpdated)}
          </span>
          <button
            onClick={refreshNews}
            disabled={isRefreshing}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors',
              'hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <RefreshCw
              size={14}
              className={isRefreshing ? 'animate-spin' : ''}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <NewsFilters
        filters={filters}
        sources={sources}
        onUpdate={updateFilters}
      />

      {/* AI batch analysis of the visible feed */}
      {newsInsight.hasArticles && (
        <AIInsightCard
          sectionKey="news-feed"
          contextKey={newsInsight.contextKey}
          contextData={newsInsight.contextData}
          title="AI Feed Analysis"
        />
      )}

      {/* Two column layout */}
      <div className="flex gap-4">
        {/* Left: News Feed (70%) */}
        <div className="flex-[7] min-w-0">
          <NewsFeed
            articles={articles}
            isLoading={isLoading}
            total={total}
            onLoadMore={loadMore}
            className="max-h-[calc(100vh-280px)]"
          />
        </div>

        {/* Right: Sidebar (30%) */}
        <div className="flex-[3] space-y-4">
          {/* Sentiment Summary */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Sentiment Overview
            </h3>

            <div className="space-y-3">
              {/* Bullish */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-emerald-400" />
                  <span className="text-xs text-[var(--color-text-secondary)]">Bullish</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-700">
                    <div
                      className="h-full rounded-full bg-emerald-400 transition-all"
                      style={{
                        width: totalSentiment > 0
                          ? `${(sentimentCounts.bullish / totalSentiment) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                  <span className="min-w-[2rem] text-right text-xs font-medium text-emerald-400">
                    {sentimentCounts.bullish}
                  </span>
                </div>
              </div>

              {/* Bearish */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingDown size={14} className="text-red-400" />
                  <span className="text-xs text-[var(--color-text-secondary)]">Bearish</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-700">
                    <div
                      className="h-full rounded-full bg-red-400 transition-all"
                      style={{
                        width: totalSentiment > 0
                          ? `${(sentimentCounts.bearish / totalSentiment) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                  <span className="min-w-[2rem] text-right text-xs font-medium text-red-400">
                    {sentimentCounts.bearish}
                  </span>
                </div>
              </div>

              {/* Neutral */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Minus size={14} className="text-gray-400" />
                  <span className="text-xs text-[var(--color-text-secondary)]">Neutral</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 overflow-hidden rounded-full bg-gray-700">
                    <div
                      className="h-full rounded-full bg-gray-400 transition-all"
                      style={{
                        width: totalSentiment > 0
                          ? `${(sentimentCounts.neutral / totalSentiment) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                  <span className="min-w-[2rem] text-right text-xs font-medium text-gray-400">
                    {sentimentCounts.neutral}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Trending Symbols */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Trending Symbols
            </h3>

            {trendingSymbols.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                No trending symbols yet
              </p>
            ) : (
              <div className="space-y-2">
                {trendingSymbols.map(({ symbol, count }) => (
                  <a
                    key={symbol}
                    href={`/charts?symbol=${symbol}`}
                    className="flex items-center justify-between rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 transition-colors hover:bg-[var(--color-accent-blue)]/10"
                  >
                    <span className="text-xs font-mono font-medium text-[var(--color-accent-blue)]">
                      {symbol}
                    </span>
                    <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                      {count} {count === 1 ? 'article' : 'articles'}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Sources breakdown */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
              Sources
            </h3>
            {sources.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">No sources loaded</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sources.map((src) => (
                  <button
                    key={src}
                    onClick={() =>
                      updateFilters({
                        source: filters.source === src ? 'all' : src,
                      })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                      filters.source === src
                        ? 'border-[var(--color-accent-blue)] bg-[var(--color-accent-blue)]/10 text-[var(--color-accent-blue)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                    )}
                  >
                    {src}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
