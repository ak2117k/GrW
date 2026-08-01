import type { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * The `Quote` shape `GET /instruments/:token/quote` returns. Mirrors
 * `Quote` in `@td/shared/types` (kept structural rather than imported so this
 * pure helper has no cross-package dependency), plus optional `oi` which the
 * broker reports for derivatives.
 */
export interface QuoteResponse {
  token: string;
  symbol: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  timestamp: Date;
  vwap?: number;
  oi?: number;
}

/** Broker numbers can arrive as NaN/Infinity/null; the client calls toFixed() on
 *  every one of them, so coerce anything non-finite to 0 at the boundary. */
function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Adapt a broker `TickData` into the `Quote` the quote endpoint contracts for.
 *
 * `TickData` (what `UserFeedSession.getQuote` and the WS feed produce) has NO
 * `change` / `changePercent` / `exchange`. `Quote` (what the frontend renders,
 * unguarded, via `q.change.toFixed(2)`) requires them. Returning a raw tick
 * therefore crashes the page — so every tick leaving the quote endpoint goes
 * through here.
 *
 * `change` is derived from the previous close and DELIBERATELY zeroed when
 * either side is missing: with `close = 0` the arithmetic would render a
 * misleading -100%. This mirrors the level-book fallback branch in
 * `market-data.controller.ts`, so both paths of the same endpoint agree.
 */
export function tickToQuote(
  tick: TickData,
  opts: { exchange: string; symbol?: string; vwap?: number },
): QuoteResponse {
  const ltp = finite(tick.ltp);
  const close = finite(tick.close);
  const change = ltp && close ? ltp - close : 0;
  const changePercent = ltp && close ? (change / close) * 100 : 0;

  return {
    token: tick.token,
    // SNAP_QUOTE / FULL responses often carry a blank tradingSymbol — fall back
    // to the symbol the controller already resolved from the instrument row.
    symbol: tick.symbol || opts.symbol || '',
    exchange: opts.exchange,
    ltp,
    open: finite(tick.open),
    high: finite(tick.high),
    low: finite(tick.low),
    close,
    volume: finite(tick.volume),
    change,
    changePercent,
    timestamp: tick.timestamp ?? new Date(),
    vwap: opts.vwap,
    oi: tick.oi,
  };
}
