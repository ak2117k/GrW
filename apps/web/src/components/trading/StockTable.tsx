import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';
import type { InstrumentResult } from '@/hooks/useInstrumentSearch';
import PriceCell from './PriceCell';

type SortField = 'symbol' | 'ltp' | 'change' | 'changePercent' | 'open' | 'high' | 'low' | 'volume';
type SortDir = 'asc' | 'desc';

interface StockTableProps {
  filter: string;
  exchangeFilter?: string;
  watchlistSymbols?: string[];
  showCommoditiesPlaceholder?: boolean;
  /** Instrument search results from API — shown when user is searching */
  searchResults?: InstrumentResult[];
  /** Whether the API search is in progress */
  searchLoading?: boolean;
  /** Called when user clicks a search result row to subscribe it to live feed */
  onSubscribeToken?: (token: string, exchange: string, symbol: string) => void;
}

const PAGE_SIZE = 25;

// F&O-relevant symbols — major indices and stocks with active F&O contracts
const FNO_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY',
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
]);

export default function StockTable({ filter, exchangeFilter, watchlistSymbols, showCommoditiesPlaceholder, searchResults, searchLoading, onSubscribeToken }: StockTableProps) {
  const quotes = useMarketStore((s) => s.quotes);
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'symbol' ? 'asc' : 'desc');
    }
  };

  // When there are API search results, merge them with any live quotes we have
  const isSearchActive = !!filter && filter.trim().length >= 2 && searchResults && searchResults.length > 0;

  // Reset to page 0 when filter or search results change
  useEffect(() => { setPage(0); }, [filter, searchResults]);

  const filtered = useMemo(() => {
    // If we have API search results, build rows from those (merged with live quote data if available)
    if (isSearchActive && searchResults) {
      const quotesMap = quotes;
      const rows: Quote[] = searchResults.map((inst) => {
        // Check if we already have a live quote for this symbol
        const liveQuote = quotesMap.get(inst.symbol);
        if (liveQuote) return liveQuote;

        // Return a placeholder row for instruments not yet in the live feed
        return {
          symbol: inst.symbol,
          token: inst.token,
          exchange: inst.exchange,
          ltp: 0,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          change: 0,
          changePercent: 0,
          volume: 0,
          timestamp: new Date(),
        } as Quote;
      });

      // Apply exchange filter if present
      let list = rows;
      if (exchangeFilter && exchangeFilter !== 'ALL') {
        if (exchangeFilter === 'NFO') {
          list = list.filter((q) => FNO_SYMBOLS.has(q.symbol));
        } else if (exchangeFilter === 'MCX') {
          list = list.filter((q) => q.exchange === 'MCX');
        } else {
          list = list.filter((q) => q.exchange === exchangeFilter);
        }
      }

      return list;
    }

    // Default behavior: filter local quote cache
    let list = Array.from(quotes.values()) as Quote[];

    if (filter) {
      const lc = filter.toLowerCase();
      list = list.filter((q) => q.symbol.toLowerCase().includes(lc));
    }
    if (exchangeFilter && exchangeFilter !== 'ALL') {
      if (exchangeFilter === 'NFO') {
        // For F&O tab, show instruments whose symbols are in the F&O set
        list = list.filter((q) => FNO_SYMBOLS.has(q.symbol));
      } else if (exchangeFilter === 'MCX') {
        // Commodities — no data yet, will be empty (handled by placeholder)
        list = list.filter((q) => q.exchange === 'MCX');
      } else {
        list = list.filter((q) => q.exchange === exchangeFilter);
      }
    }
    if (watchlistSymbols) {
      const set = new Set(watchlistSymbols);
      list = list.filter((q) => set.has(q.symbol));
    }

    list.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const diff = (aVal as number) - (bVal as number);
      return sortDir === 'asc' ? diff : -diff;
    });

    return list;
  }, [quotes, filter, exchangeFilter, watchlistSymbols, sortField, sortDir, isSearchActive, searchResults]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const SortHeader = ({ field, label, className }: { field: SortField; label: string; className?: string }) => (
    <th
      onClick={() => handleSort(field)}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown size={10} className={sortField === field ? 'text-[var(--color-accent-blue)]' : 'opacity-40'} />
      </span>
    </th>
  );

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-subtle)]">
              <SortHeader field="symbol" label="Symbol" className="!text-left" />
              <SortHeader field="ltp" label="LTP" />
              <SortHeader field="change" label="Change" />
              <SortHeader field="changePercent" label="Chg%" />
              <SortHeader field="open" label="Open" />
              <SortHeader field="high" label="High" />
              <SortHeader field="low" label="Low" />
              <SortHeader field="volume" label="Volume" />
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-[var(--color-text-muted)]">
                  {searchLoading
                    ? 'Searching instruments...'
                    : showCommoditiesPlaceholder
                      ? 'No commodity data available'
                      : quotes.size === 0
                        ? 'Waiting for market data...'
                        : isSearchActive
                          ? `No matching instruments for "${filter}"`
                          : 'No matching instruments'}
                </td>
              </tr>
            ) : (
              paged.map((q) => {
                const isPos = q.change >= 0;
                const hasLiveData = q.ltp > 0;
                return (
                  <tr
                    key={`${q.exchange}-${q.symbol}`}
                    onClick={() => {
                      // If this is a search result without live data, subscribe it to the feed
                      if (!hasLiveData && onSubscribeToken && q.token) {
                        onSubscribeToken(q.token, q.exchange, q.symbol);
                      }
                      navigate(`/charts?symbol=${q.symbol}&exchange=${q.exchange}&token=${q.token ?? ''}`);
                    }}
                    className="cursor-pointer border-b border-[var(--color-border-subtle)]/50 transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-left font-medium text-[var(--color-text-primary)]">
                      <div className="flex flex-col">
                        <span>{q.symbol}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{q.exchange}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-primary)]">
                      {hasLiveData ? <PriceCell price={q.ltp} /> : <span className="text-[var(--color-text-muted)]">--</span>}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-mono ${hasLiveData ? (isPos ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]') : 'text-[var(--color-text-muted)]'}`}>
                      {hasLiveData ? `${isPos ? '+' : ''}${q.change.toFixed(2)}` : '--'}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-mono ${hasLiveData ? (isPos ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]') : 'text-[var(--color-text-muted)]'}`}>
                      {hasLiveData ? `${isPos ? '+' : ''}${q.changePercent.toFixed(2)}%` : '--'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {hasLiveData ? q.open.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '--'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {hasLiveData ? q.high.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '--'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {hasLiveData ? q.low.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '--'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text-secondary)]">
                      {hasLiveData ? q.volume.toLocaleString('en-IN') : '--'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-3 py-2">
          <span className="text-xs text-[var(--color-text-muted)]">
            {filtered.length} instruments | Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
