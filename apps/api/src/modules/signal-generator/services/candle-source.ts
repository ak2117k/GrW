/**
 * A candle source bound to ONE request.
 *
 * WHY this exists: this platform is multi-tenant and has NO shared feed
 * account. Every signal-generator service reaches for `AngelOneAdapterService`
 * (the SHARED Angel session), and `AngelOneAuthService` skips login when no
 * feed account is resolvable — so `getSmartApi()` throws
 * `Not authenticated. Call login() first.` for every call. On the S/R path that
 * throw was caught, logged at debug, and fell through to a DB lookup that
 * misses for indices: the engine returned `[]` for every symbol and every
 * timeframe, permanently and silently. The chart honestly reported
 * "S/R: none in range" because that is exactly what the backend said.
 *
 * The chart's own candles were migrated to `UserFeedManager.fetchCandles`
 * (each user's own Angel session) for precisely this reason; the S/R engine
 * never was. Rather than migrate all twelve signal-generator services — the
 * background consumers (universe-scanner, chartink, ml/*, asymmetric-scanner)
 * have NO user context and must keep using the shared adapter — the
 * user-scoped request path passes one of these down as an OPTIONAL trailing
 * argument.
 *
 * The contract that makes that safe:
 *   - ABSENT  ⇒ byte-identical to the pre-existing behaviour (shared adapter,
 *               then the DB fallback). Every background caller passes nothing.
 *   - PRESENT ⇒ tried FIRST; a throw or an unusably short series degrades to
 *               the same documented fallback rather than failing the request.
 */

/** One OHLCV bar, in the shape every candle consumer in this module reads. */
export interface CandleSourceCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSource {
  getCandles(
    token: string,
    exchange: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<CandleSourceCandle[]>;
}
