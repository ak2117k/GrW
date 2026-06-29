import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import api from '@/services/api';
import type { OptionsChainEntry } from '@/types';
import { useMarketStore } from '@/stores/market-store';
import { Card } from './_shared';

interface Props {
  symbol: string;
  /** Used to disambiguate the WS quote lookup — the market-store is keyed
   *  by symbol, but the symbol carried in the WS payload may not match
   *  what the user searched. Keying by token is unambiguous. */
  token?: string;
  /** NSE / BSE / NFO / MCX / CDS. Used to gate the card off for segments
   *  whose options chains aren't served by /api/options/chain. */
  exchange?: string;
}

/**
 * Exchange codes whose options chains aren't supported by the equity
 * /options/chain endpoint. Commodity options (MCX) and currency
 * derivatives (CDS) live in different segments with different chain
 * shapes — querying them returns either an unrelated chain or junk data.
 * Equity F&O on NFO and indices on NSE work normally.
 */
const NON_EQUITY_FNO_EXCHANGES = new Set(['MCX', 'CDS']);

interface ChainResponse {
  chain: OptionsChainEntry[];
  expiry: string | null;
  spotPrice: number;
  underlying: string;
}

/**
 * Card 5: ATM ± 3 strikes preview (7 rows). Hidden entirely for cash-only
 * symbols (the underlying isn't an F&O instrument, so /options/chain
 * returns an empty array).
 *
 * Columns: CE LTP | CE OI Δ | Strike | PE OI Δ | PE LTP. ATM row highlighted.
 * Footer links to the full /options/<symbol> page.
 *
 * Fetches its own chain (rather than reusing useOptionsChain's Zustand
 * store) because the store is wired to the global "selected underlying"
 * for the dedicated Options page; this card needs to follow whatever
 * symbol the chart is showing without fighting the store.
 */
export default function OptionsChainPreviewCard({ symbol, token, exchange }: Props) {
  // Segment-level gate computed up front, but the early return is placed
  // AFTER all hooks below to satisfy the Rules of Hooks (the hook count
  // must be stable across renders).
  const unsupportedSegment = !!exchange && NON_EQUITY_FNO_EXCHANGES.has(exchange.toUpperCase());

  // Symbol-keyed lookup with a token-based fallback — see LiveQuoteCard
  // for the full rationale. Without this we render a NIFTY-priced ATM
  // strike for a stock when the demo seed has NIFTY in the store.
  const wsQuote = useMarketStore((s) => {
    const bySymbol = s.quotes.get(symbol);
    if (!token) return bySymbol;
    if (bySymbol && bySymbol.token === token) return bySymbol;
    for (const q of s.quotes.values()) if (q.token === token) return q;
    return undefined;
  });
  const [data, setData] = useState<ChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // Skip the fetch when the segment isn't supported (commodities,
    // currency derivatives) — the card hides anyway, but firing the
    // request just to hide the result generates noisy 404s in the
    // network tab. Stay quiet on the wire.
    if (!symbol || unsupportedSegment) {
      setData(null);
      setErrored(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    setData(null);
    api
      .get<ChainResponse>(`/options/chain/${symbol}`)
      .then((r) => {
        if (cancelled) return;
        setData(r.data);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, unsupportedSegment]);

  // Prefer the WS quote LTP (real-time), fall back to the spotPrice the
  // backend returned with the chain (some indices have no token in the
  // market-store map).
  const ltp = wsQuote?.ltp ?? data?.spotPrice ?? null;

  const slice = useMemo(() => {
    if (!data?.chain || data.chain.length === 0 || ltp == null || ltp <= 0) return [];
    const sorted = [...data.chain].sort((a, b) => a.strikePrice - b.strikePrice);
    let bestIdx = 0;
    let bestDiff = Math.abs(sorted[0].strikePrice - ltp);
    for (let i = 1; i < sorted.length; i++) {
      const diff = Math.abs(sorted[i].strikePrice - ltp);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const start = Math.max(0, bestIdx - 3);
    const end = Math.min(sorted.length, bestIdx + 4);
    return sorted.slice(start, end);
  }, [data, ltp]);

  // Now that all hooks have run, gate the render. Commodities/currencies
  // hide unconditionally — their chains aren't equity-shaped.
  if (unsupportedSegment) return null;

  if (loading && !data) {
    return (
      <Card title="Options Chain">
        <p className="text-sm text-zinc-500">Loading options chain...</p>
      </Card>
    );
  }

  // Cash-only stock or chain genuinely empty → hide the card entirely.
  // Same when the request errored — the underlying probably doesn't exist
  // on the F&O segment (e.g. small caps).
  if (errored) return null;
  if (!data || !data.chain || data.chain.length === 0) return null;

  // Recompute ATM strike for the row-highlight check (within the slice).
  const atmStrike =
    ltp != null && slice.length > 0
      ? slice.reduce(
          (best, row) =>
            Math.abs(row.strikePrice - ltp) < Math.abs(best - ltp) ? row.strikePrice : best,
          slice[0].strikePrice,
        )
      : null;

  return (
    <Card
      title={`Options Chain${data.expiry ? ` — ${data.expiry.slice(0, 10)}` : ''}`}
      action={
        <Link to={`/options/${symbol}`} className="text-xs text-blue-400 hover:text-blue-300">
          View full chain →
        </Link>
      }
    >
      {slice.length === 0 ? (
        <p className="text-sm text-zinc-500">No strikes within range.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-right font-normal pb-1">CE LTP</th>
              <th className="text-right font-normal pb-1">CE OI Δ</th>
              <th className="text-center font-normal pb-1">Strike</th>
              <th className="text-right font-normal pb-1">PE OI Δ</th>
              <th className="text-right font-normal pb-1">PE LTP</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((row) => {
              const isAtm = row.strikePrice === atmStrike;
              return (
                <tr
                  key={row.strikePrice}
                  className={clsx(isAtm && 'bg-blue-900/30')}
                >
                  <td className="text-right tabular-nums text-emerald-300">
                    {row.ceData?.ltp != null ? row.ceData.ltp.toFixed(2) : '—'}
                  </td>
                  <td className="text-right tabular-nums text-zinc-400">
                    {row.ceData?.oiChange != null
                      ? row.ceData.oiChange.toLocaleString('en-IN')
                      : '—'}
                  </td>
                  <td className="text-center tabular-nums text-zinc-200 font-medium">
                    {row.strikePrice}
                  </td>
                  <td className="text-right tabular-nums text-zinc-400">
                    {row.peData?.oiChange != null
                      ? row.peData.oiChange.toLocaleString('en-IN')
                      : '—'}
                  </td>
                  <td className="text-right tabular-nums text-red-300">
                    {row.peData?.ltp != null ? row.peData.ltp.toFixed(2) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
