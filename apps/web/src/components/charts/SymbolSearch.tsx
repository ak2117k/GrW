import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import api from '@/services/api';
import { useChartStore, type SelectedSymbol } from '@/stores/chart-store';

interface InstrumentResult {
  symbol: string;
  token: string;
  exchange: string;
  name: string;
}

export default function SymbolSearch() {
  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const setSymbol = useChartStore((s) => s.setSymbol);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstrumentResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.length < 1) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const response = await api.get('/market-data/instruments', {
        params: { search: searchQuery },
      });
      // The market-data API wraps results as `{ instruments: [...] }`. Older
      // shapes used `{ data: [...] }` or a bare array — handle all three.
      const payload = response.data;
      const raw =
        (payload?.instruments as InstrumentResult[] | undefined) ??
        (payload?.data as InstrumentResult[] | undefined) ??
        payload;
      const list: InstrumentResult[] = Array.isArray(raw) ? raw : [];
      setResults(list.slice(0, 10));
    } catch (err) {
      // Log so contract drift / network failures aren't invisible — silent
      // fallback was hiding a real shape mismatch in the past.
      console.warn('SymbolSearch: instrument lookup failed', err);
      setResults(
        [
          { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', name: 'NIFTY 50' },
          { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', name: 'BANK NIFTY' },
          { symbol: 'FINNIFTY', token: '99926037', exchange: 'NSE', name: 'FIN NIFTY' },
          { symbol: 'SENSEX', token: '99919000', exchange: 'BSE', name: 'SENSEX' },
        ].filter(
          (i) =>
            i.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
            i.name.toLowerCase().includes(searchQuery.toLowerCase()),
        ),
      );
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleInputChange = (value: string) => {
    setQuery(value);
    setHighlightIndex(-1);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const selectSymbol = (instrument: InstrumentResult) => {
    const sym: SelectedSymbol = {
      symbol: instrument.symbol,
      token: instrument.token,
      exchange: instrument.exchange,
      name: instrument.name,
    };
    setSymbol(sym);
    setQuery('');
    setIsOpen(false);
    setResults([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && highlightIndex >= 0 && results[highlightIndex]) {
      e.preventDefault();
      selectSymbol(results[highlightIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div ref={dropdownRef} className="relative">
      <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border-subtle)] px-3 py-1.5 min-w-[220px]">
        <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
        {!isOpen && !query && (
          <button
            onClick={() => {
              setIsOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
          >
            <span>{selectedSymbol.symbol}</span>
            <span className="text-[var(--color-text-muted)] font-normal text-xs">
              {selectedSymbol.exchange}
            </span>
          </button>
        )}
        {(isOpen || query) && (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search symbol..."
            className="bg-transparent text-sm text-[var(--color-text-primary)] outline-none w-full placeholder:text-[var(--color-text-muted)]"
            autoFocus
          />
        )}
        {query && (
          <button
            onClick={() => {
              setQuery('');
              setResults([]);
              setIsOpen(false);
            }}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-full min-w-[300px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-xl z-50 overflow-hidden">
          {isSearching && (
            <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
              Searching...
            </div>
          )}
          {results.map((instrument, idx) => (
            <button
              key={`${instrument.token}-${instrument.exchange}`}
              onClick={() => selectSymbol(instrument)}
              onMouseEnter={() => setHighlightIndex(idx)}
              className={`w-full px-3 py-2 flex items-center justify-between text-left transition-colors ${
                idx === highlightIndex
                  ? 'bg-[var(--color-bg-tertiary)]'
                  : 'hover:bg-[var(--color-bg-tertiary)]'
              }`}
            >
              <div>
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {instrument.symbol}
                </span>
                <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                  {instrument.name}
                </span>
              </div>
              <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 rounded">
                {instrument.exchange}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
