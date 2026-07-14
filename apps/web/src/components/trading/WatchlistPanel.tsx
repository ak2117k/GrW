import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus, Search, Star } from 'lucide-react';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useWatchlistQuotes } from '@/hooks/useWatchlistQuotes';
import type { WatchlistItem } from '@/stores/watchlist-store';
import PriceCell from './PriceCell';

const SEARCH_SUGGESTIONS: WatchlistItem[] = [
  { symbol: 'INFY', token: '1594', exchange: 'NSE', name: 'Infosys' },
  { symbol: 'ICICIBANK', token: '4963', exchange: 'NSE', name: 'ICICI Bank' },
  { symbol: 'SBIN', token: '3045', exchange: 'NSE', name: 'State Bank of India' },
  { symbol: 'ITC', token: '1660', exchange: 'NSE', name: 'ITC Ltd' },
  { symbol: 'WIPRO', token: '3787', exchange: 'NSE', name: 'Wipro' },
  { symbol: 'AXISBANK', token: '5900', exchange: 'NSE', name: 'Axis Bank' },
  { symbol: 'KOTAKBANK', token: '1922', exchange: 'NSE', name: 'Kotak Mahindra Bank' },
  { symbol: 'LT', token: '11483', exchange: 'NSE', name: 'Larsen & Toubro' },
  { symbol: 'BHARTIARTL', token: '10604', exchange: 'NSE', name: 'Bharti Airtel' },
  { symbol: 'MARUTI', token: '10999', exchange: 'NSE', name: 'Maruti Suzuki' },
  { symbol: 'GOLD', token: '477904', exchange: 'MCX', name: 'Gold' },
  { symbol: 'SILVER', token: '457532', exchange: 'MCX', name: 'Silver' },
  { symbol: 'NATURALGAS', token: '538685', exchange: 'MCX', name: 'Natural Gas' },
];

export default function WatchlistPanel() {
  const { entries, watchlist, addToWatchlist, removeFromWatchlist } = useWatchlist();
  // Keep every watchlist row live (esp. stocks the WS tick feed doesn't push).
  useWatchlistQuotes(watchlist);
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [searchText, setSearchText] = useState('');

  const existingTokens = new Set(entries.map((e) => e.token));

  const filteredSuggestions = SEARCH_SUGGESTIONS.filter(
    (s) =>
      !existingTokens.has(s.token) &&
      (s.symbol.toLowerCase().includes(searchText.toLowerCase()) ||
        s.name.toLowerCase().includes(searchText.toLowerCase())),
  );

  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Star size={14} className="text-[var(--color-accent-yellow)]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">Watchlist</span>
          <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            {entries.length}
          </span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-accent-blue)]"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Add Symbol */}
      {showAdd && (
        <div className="border-b border-[var(--color-border-subtle)] p-3">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-3 py-1.5">
            <Search size={12} className="text-[var(--color-text-muted)]" />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search symbol..."
              className="w-full bg-transparent text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
              autoFocus
            />
          </div>
          {searchText && (
            <div className="mt-2 max-h-32 overflow-y-auto">
              {filteredSuggestions.length === 0 ? (
                <p className="py-2 text-center text-xs text-[var(--color-text-muted)]">No results</p>
              ) : (
                filteredSuggestions.map((s) => (
                  <button
                    key={s.token}
                    onClick={() => {
                      addToWatchlist(s);
                      setSearchText('');
                      setShowAdd(false);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <div>
                      <span className="font-medium text-[var(--color-text-primary)]">{s.symbol}</span>
                      <span className="ml-2 text-[var(--color-text-muted)]">{s.name}</span>
                    </div>
                    <Plus size={12} className="text-[var(--color-accent-green)]" />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Watchlist Items */}
      <div className="max-h-[400px] overflow-y-auto">
        {entries.length === 0 ? (
          <p className="py-8 text-center text-xs text-[var(--color-text-muted)]">
            Watchlist is empty. Click + to add symbols.
          </p>
        ) : (
          entries.map((entry) => {
            const q = entry.quote;
            const isPos = (q?.change ?? 0) >= 0;

            return (
              <div
                key={entry.token}
                className="group flex items-center justify-between border-b border-[var(--color-border-subtle)]/30 px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-tertiary)]"
              >
                <div
                  className="flex flex-1 cursor-pointer flex-col"
                  onClick={() =>
                    navigate(`/charts?symbol=${entry.symbol}&exchange=${entry.exchange}&token=${entry.token}`)
                  }
                >
                  <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                    {entry.symbol}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">{entry.name}</span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end">
                    {q ? (
                      <>
                        <span className="text-xs font-mono font-medium text-[var(--color-text-primary)]">
                          <PriceCell price={q.ltp} />
                        </span>
                        <span
                          className={`text-[10px] font-mono ${isPos ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}
                        >
                          {isPos ? '+' : ''}{q.changePercent.toFixed(2)}%
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">--</span>
                    )}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromWatchlist(entry.token);
                    }}
                    className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-all hover:bg-[var(--color-accent-red)]/20 hover:text-[var(--color-accent-red)] group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
