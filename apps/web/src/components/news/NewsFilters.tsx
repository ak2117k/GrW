import { Tabs, SearchInput } from '@/components/common';
import { cn } from '@/utils/cn';
import type { NewsFilters as NewsFiltersType } from '@/stores/news-store';

interface NewsFiltersProps {
  filters: NewsFiltersType;
  sources: string[];
  onUpdate: (partial: Partial<NewsFiltersType>) => void;
  className?: string;
}

const CATEGORY_TABS = [
  { key: 'all', label: 'All' },
  { key: 'indian', label: 'Indian' },
  { key: 'global', label: 'Global' },
  { key: 'sector', label: 'Sector' },
  { key: 'company', label: 'Company' },
];

const SENTIMENT_OPTIONS = [
  { value: 'all', label: 'All Sentiment' },
  { value: 'bullish', label: 'Bullish' },
  { value: 'bearish', label: 'Bearish' },
  { value: 'neutral', label: 'Neutral' },
];

export default function NewsFilters({
  filters,
  sources,
  onUpdate,
  className,
}: NewsFiltersProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {/* Category tabs */}
      <Tabs
        tabs={CATEGORY_TABS}
        activeTab={filters.category}
        onChange={(key) => onUpdate({ category: key })}
      />

      {/* Second row: sentiment, source, search */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Sentiment dropdown */}
        <select
          value={filters.sentiment}
          onChange={(e) => onUpdate({ sentiment: e.target.value })}
          className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
        >
          {SENTIMENT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Source dropdown */}
        <select
          value={filters.source}
          onChange={(e) => onUpdate({ source: e.target.value })}
          className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
        >
          <option value="all">All Sources</option>
          {sources.map((src) => (
            <option key={src} value={src}>
              {src}
            </option>
          ))}
        </select>

        {/* Search */}
        <SearchInput
          placeholder="Search news..."
          value={filters.search}
          onChange={(value) => onUpdate({ search: value })}
          className="w-64"
        />
      </div>
    </div>
  );
}
