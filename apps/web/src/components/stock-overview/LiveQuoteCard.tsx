import { useEffect, useState } from 'react';
import { useMarketStore } from '@/stores/market-store';
import api from '@/services/api';
import type { Quote } from '@/types';
import { Card, Stat } from './_shared';

interface Props {
  token: string;
  exchange: string;
  symbol: string;
}

/**
 * Card 2: Live ticker for the selected instrument.
 *
 * Source priority:
 *   1. WebSocket-fed `useMarketStore` quote (keyed by symbol) — preferred
 *      because it updates in real time as ticks flow in.
 *   2. Fallback REST fetch of /market-data/instruments/:token/quote on mount
 *      so the card has *something* to render before the first tick arrives
 *      (or when the symbol isn't in the WS-subscribed universe).
 *
 * Renders LTP, change abs/%, day H/L (with a position indicator within the
 * day's range), Open, Prev Close, VWAP (omitted when undefined — backend
 * Quote.vwap is optional), and Volume.
 */
export default function LiveQuoteCard({ token, exchange, symbol }: Props) {
  // Prefer exact symbol match, but fall back to a token-based scan so the
  // card doesn't render a stale/colliding quote when the searched symbol
  // string doesn't match what the WS payload carried (e.g. demo seed
  // pre-loads NIFTY into the store under symbol="NIFTY" and a search for
  // SBI under a different store key would otherwise hit the NIFTY entry
  // because of a name collision elsewhere in the pipeline). Token is
  // unambiguous — same key the chart and analyze() use.
  const wsQuote = useMarketStore((s) => {
    const bySymbol = s.quotes.get(symbol);
    if (bySymbol && bySymbol.token === token) return bySymbol;
    for (const q of s.quotes.values()) if (q.token === token) return q;
    return undefined;
  });
  const [restQuote, setRestQuote] = useState<Quote | null>(null);

  // REST fallback so the card isn't blank before the first WS tick.
  useEffect(() => {
    if (!token || token === '0' || !exchange) return;
    let cancelled = false;
    api
      .get<{ quote: Quote | null }>(`/market-data/instruments/${token}/quote`, {
        params: { exchange },
      })
      .then((r) => {
        if (cancelled) return;
        if (r.data?.quote) setRestQuote(r.data.quote);
      })
      .catch(() => {
        // Soft fail — WS quote may still arrive.
      });
    return () => {
      cancelled = true;
    };
  }, [token, exchange]);

  const q = wsQuote ?? restQuote;

  if (!q) {
    return (
      <Card title="Live Quote">
        <p className="text-sm text-zinc-500">Loading...</p>
      </Card>
    );
  }

  const positive = q.change >= 0;
  const rangePct = q.high === q.low ? 0 : ((q.ltp - q.low) / (q.high - q.low)) * 100;
  const clampedPct = Math.min(100, Math.max(0, rangePct));

  return (
    <Card title="Live Quote">
      <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
        <div className={`text-3xl font-semibold tabular-nums ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {q.ltp.toFixed(2)}
        </div>
        <div className={`text-sm tabular-nums ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {positive ? '+' : ''}
          {q.change.toFixed(2)} ({q.changePercent.toFixed(2)}%)
        </div>
        <Stat label="Day H" value={fmtPriceOrDash(q.high)} />
        <Stat label="Day L" value={fmtPriceOrDash(q.low)} />
        <Stat label="Open" value={fmtPriceOrDash(q.open)} />
        <Stat label="Prev Close" value={fmtPriceOrDash(q.close)} />
        <Stat label="VWAP" value={q.vwap ? q.vwap.toFixed(2) : '—'} />
        <Stat label="Volume" value={q.volume > 0 ? q.volume.toLocaleString('en-IN') : '—'} />
      </div>

      {/* Day-range bar — LTP position within day H/L */}
      {q.high > q.low && (
        <div className="mt-4">
          <div className="relative h-1 bg-zinc-700 rounded-full">
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-3 bg-blue-400 rounded-sm"
              style={{ left: `${clampedPct}%` }}
              title={`LTP at ${clampedPct.toFixed(0)}% of day range`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1 tabular-nums">
            <span>L {q.low.toFixed(2)}</span>
            <span>H {q.high.toFixed(2)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Render a price field, but coerce 0 → "—". The level-book-seeded quote
 * (used after-hours when no live tick is cached) reports 0 for fields the
 * book doesn't track yet (Day H/L/Open before today's first tick). Showing
 * "0.00" in that case is misleading — the value is unknown, not zero.
 */
function fmtPriceOrDash(value: number): string {
  return value > 0 ? value.toFixed(2) : '—';
}
