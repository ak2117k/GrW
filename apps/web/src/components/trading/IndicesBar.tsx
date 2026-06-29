import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { INDICES } from '@td/shared';
import { useMarketStore } from '@/stores/market-store';
import PriceCell from './PriceCell';

const INDEX_LIST = Object.entries(INDICES).map(([key, val]) => ({
  key,
  ...val,
}));

export default function IndicesBar() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const quotes = useMarketStore((s) => s.quotes);

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = 260;
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -amount : amount,
      behavior: 'smooth',
    });
  };

  return (
    <div className="relative flex items-center gap-1">
      <button
        onClick={() => scroll('left')}
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <ChevronLeft size={16} />
      </button>

      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto scroll-smooth"
        style={{ scrollbarWidth: 'none' }}
      >
        {INDEX_LIST.map(({ key, symbol, exchange }) => {
          const quote = quotes.get(symbol);
          const ltp = quote?.ltp ?? 0;
          const change = quote?.change ?? 0;
          const changePct = quote?.changePercent ?? 0;
          const isPositive = change >= 0;

          return (
            <div
              key={key}
              className="flex shrink-0 flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-2"
              style={{ minWidth: 200 }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                  {symbol}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)]">{exchange}</span>
              </div>

              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-sm font-bold text-[var(--color-text-primary)]">
                  {ltp ? <PriceCell price={ltp} /> : '--,---'}
                </span>
                <span
                  className={`text-xs font-medium ${isPositive ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}
                >
                  {ltp
                    ? `${isPositive ? '+' : ''}${change.toFixed(2)} (${isPositive ? '+' : ''}${changePct.toFixed(2)}%)`
                    : '-- (--)'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => scroll('right')}
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
