import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Globe, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { useMarketStore } from '@/stores/market-store';
import { feedBadge } from '@/services/feed-health';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useInstrumentSearch } from '@/hooks/useInstrumentSearch';
import { useCommodities } from '@/hooks/useCommodities';
import api from '@/services/api';
import {
  IndicesBar,
  StockTable,
  WatchlistPanel,
  SectorHeatmap,
  MarketBreadth,
} from '@/components/trading';

type Tab = 'all' | 'fno' | 'commodities' | 'watchlist';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All Stocks' },
  { key: 'fno', label: 'F&O' },
  { key: 'commodities', label: 'Commodities' },
  { key: 'watchlist', label: 'My Watchlist' },
];

/** Health tone -> colour token. Stale gets its own colour; it is its own state. */
const FEED_TONE: Record<'positive' | 'warning' | 'negative', string> = {
  positive: 'text-[var(--color-accent-green)]',
  warning: 'text-[var(--color-accent-yellow)]',
  negative: 'text-[var(--color-accent-red)]',
};

export default function MarketPage() {
  const [activeTab, setActiveTab] = useState<Tab>('all');

  // Commodities come straight from Angel (front-month resolved server-side) into
  // the quote store; only poll while the Commodities tab is open.
  useCommodities(activeTab === 'commodities');
  const [searchText, setSearchText] = useState('');
  const [exchangeFilter, setExchangeFilter] = useState('ALL');
  const [showDropdown, setShowDropdown] = useState(false);
  const feedHealth = useMarketStore((s) => s.feedHealth);
  const feed = feedBadge(feedHealth);
  const { watchlist } = useWatchlist();
  const navigate = useNavigate();
  const { results: searchResults, isLoading: searchLoading, search: doSearch, clear: clearSearch } = useInstrumentSearch();
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Trigger API search when searchText changes
  useEffect(() => {
    if (searchText.trim().length >= 2) {
      doSearch(searchText);
      setShowDropdown(true);
    } else {
      clearSearch();
      setShowDropdown(false);
    }
  }, [searchText, doSearch, clearSearch]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Subscribe a token to the live market data feed when user clicks a search result
  const handleSubscribeToken = useCallback(async (token: string, _exchange: string, _symbol: string) => {
    try {
      await api.post('/market-data/watchlist/subscribe', {
        tokens: [token],
      });
    } catch {
      // Silently fail — the user will still navigate to the chart page
    }
  }, []);

  const exchangeForTab = (() => {
    if (activeTab === 'fno') return 'NFO';
    if (activeTab === 'commodities') return 'MCX';
    if (exchangeFilter !== 'ALL') return exchangeFilter;
    return undefined;
  })();

  const watchlistSymbols = activeTab === 'watchlist' ? watchlist.map((w) => w.symbol) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Globe size={22} className="text-[var(--color-accent-blue)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Market Overview</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-xs ${FEED_TONE[feed.tone]}`}>
            {feed.wifi ? <Wifi size={12} /> : <WifiOff size={12} />}
            {feed.label}
          </span>
        </div>
      </div>

      {/* Indices Bar */}
      <IndicesBar />

      {/* Search Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1" ref={searchContainerRef}>
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2">
            {searchLoading ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-[var(--color-accent-blue)]" />
            ) : (
              <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            )}
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onFocus={() => { if (searchResults.length > 0) setShowDropdown(true); }}
              placeholder="Search stocks, indices, commodities..."
              className="w-full min-w-0 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
            {searchText && (
              <button
                onClick={() => { setSearchText(''); clearSearch(); setShowDropdown(false); }}
                className="shrink-0 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              >
                Clear
              </button>
            )}
          </div>

          {/* Search Results Dropdown */}
          {showDropdown && searchText.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-lg">
              {searchLoading && searchResults.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--color-text-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  Searching...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-3 text-sm text-[var(--color-text-muted)]">
                  No instruments found for &ldquo;{searchText}&rdquo;
                </div>
              ) : (
                <>
                  <div className="border-b border-[var(--color-border-subtle)] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </div>
                  {searchResults.map((inst) => (
                    <button
                      key={`${inst.exchange}-${inst.token}`}
                      onClick={() => {
                        setShowDropdown(false);
                        navigate(`/charts?symbol=${encodeURIComponent(inst.symbol)}&exchange=${encodeURIComponent(inst.exchange)}&token=${encodeURIComponent(inst.token)}`);
                      }}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-[var(--color-text-primary)]">
                          {inst.symbol}
                        </span>
                        <span className="text-[11px] text-[var(--color-text-muted)]">
                          {inst.name !== inst.symbol ? inst.name : ''}
                        </span>
                      </div>
                      <span className="rounded bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
                        {inst.exchange}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        {activeTab === 'all' && (
          <select
            value={exchangeFilter}
            onChange={(e) => setExchangeFilter(e.target.value)}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-secondary)] outline-none"
          >
            <option value="ALL">All Exchanges</option>
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
            <option value="MCX">MCX</option>
            <option value="NFO">NFO</option>
          </select>
        )}
      </div>

      {/* Main Content */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left Panel - 70% */}
        <div className="flex flex-col gap-0 lg:w-[70%]">
          {/* Tabs */}
          <div className="flex gap-0 border-b border-[var(--color-border-subtle)]">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-xs font-semibold transition-colors ${
                  activeTab === tab.key
                    ? 'border-b-2 border-[var(--color-accent-blue)] text-[var(--color-accent-blue)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Stock Table */}
          <div className="rounded-b-xl border border-t-0 border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
            <StockTable
              filter={searchText}
              exchangeFilter={exchangeForTab}
              watchlistSymbols={watchlistSymbols}
              showCommoditiesPlaceholder={activeTab === 'commodities'}
              searchResults={searchResults}
              searchLoading={searchLoading}
              onSubscribeToken={handleSubscribeToken}
            />
          </div>
        </div>

        {/* Right Panel - 30% */}
        <div className="flex flex-col gap-4 lg:w-[30%]">
          <WatchlistPanel />
          <MarketBreadth />
        </div>
      </div>

      {/* Bottom: Sector Heatmap */}
      <SectorHeatmap />
    </div>
  );
}
