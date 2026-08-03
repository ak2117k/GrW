import type { Candle } from '../services/user-historical.util';
import type { QuoteResponse } from './tick-to-quote';

/**
 * Build a `Quote` from daily candles, for instruments the broker's quote API
 * will not serve.
 *
 * Angel's `marketData({ mode: 'FULL' })` does not return NSE index tokens for
 * most API keys — they land in `data.unfetched`, which is why every `999260xx`
 * tile rendered "--" while SENSEX (BSE, quotable) showed real numbers. The
 * adapter's original answer was to fall back to the shared WS tick cache; that
 * cache no longer exists (the shared feed account was abandoned), and the
 * level-book fallback is no help either since it reads through the same dead
 * shared adapter.
 *
 * `getCandleData` DOES serve these tokens — it is what draws the charts — so
 * the last two daily candles give a genuine LTP (today's close, which tracks
 * intraday) and a genuine previous close.
 */
export function quoteFromDailyCandles(
  candles: Candle[],
  opts: { token: string; symbol: string; exchange: string },
): QuoteResponse | null {
  if (candles.length === 0) return null;

  // Broker chunks are fetched newest-first and merged, so never assume order.
  const sorted = [...candles].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  const ltp = latest.close;
  // With no prior session we have nothing to compare against — zero the change
  // rather than inventing a move (mirrors tickToQuote / the level-book branch).
  const prevClose = previous ? previous.close : 0;
  const change = ltp && prevClose ? ltp - prevClose : 0;
  const changePercent = ltp && prevClose ? (change / prevClose) * 100 : 0;

  return {
    token: opts.token,
    symbol: opts.symbol,
    exchange: opts.exchange,
    ltp,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: prevClose,
    volume: latest.volume,
    change,
    changePercent,
    timestamp: latest.timestamp,
  };
}

/**
 * Render Angel's `data.unfetched` entries for logging. This array is the ONLY
 * place the broker explains WHY a token was refused (`errorCode` / `message`),
 * and dropping it silently is what made the blank index tiles so hard to
 * attribute. Returns '' when nothing was refused.
 */
export function describeUnfetched(unfetched: unknown): string {
  if (!Array.isArray(unfetched) || unfetched.length === 0) return '';
  return unfetched
    .map((u: any) => {
      const token = `${u?.exchange ?? '?'}:${u?.symbolToken ?? u?.symboltoken ?? '?'}`;
      const reason = [u?.errorCode, u?.message].filter(Boolean).join(' ');
      return reason ? `${token} (${reason})` : token;
    })
    .join(', ');
}
