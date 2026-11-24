import { sessionOnlyBars } from '../../exit-discipline/session-bars';
import { mergeTrendBars, TREND_MAX_BARS, type TrendBar } from '../domain/trend-tag';
import type { SignalTraderRepository } from '../repositories/signal-trader.repository';

/** candles_1m read for the trend: ~5 NSE sessions of 15m bars past weekends / a holiday (MCX needs ~2). */
export const TREND_HUB_LOOKBACK_MS = 10 * 86_400_000;

/** The two bar reads the loader needs (SignalTraderRepository implements them). */
export type TrendBarsRepo = Pick<SignalTraderRepository, 'hub15mBars' | 'stored15mBars'>;

/**
 * The completed 15m bars of a price line for the trend tag (domain/trend-tag): the hub's candles_1m
 * rolled to 15m (last {@link TREND_HUB_LOOKBACK_MS}) merged over the persisted `candles` 15m history
 * (newest {@link TREND_MAX_BARS}). Database reads only, never the broker. Shared by the signal-trader's
 * market.trend (signal-context.service, which caches it per quarter-hour) and the entry engine's
 * indicators gate (2026-11-11), so both read the same bars.
 */
export async function loadTrendBars(repo: TrendBarsRepo, ref: { exchange: string; token: string; symbol: string }, now: Date): Promise<{ bars: TrendBar[]; source: string }> {
  const [hub, older] = await Promise.all([
    repo.hub15mBars(ref.exchange, ref.token, new Date(now.getTime() - TREND_HUB_LOOKBACK_MS), now),
    repo.stored15mBars(ref.exchange, ref.token, TREND_MAX_BARS, now).catch(() => [] as TrendBar[]),
  ]);
  // Session buckets only (exit-discipline/session-bars): the hub's date_bin is epoch-aligned, which IS the session grid for
  // NSE/BSE (09:15) and MCX (09:00), so dropping the buckets that start off-session (the NSE pre-open 09:00 bucket, the
  // flat night/post-close buckets) leaves no bucket that mixes pre-open and session minutes.
  return {
    bars: sessionOnlyBars(mergeTrendBars(older, hub, now), ref.exchange, 15),
    source: `candles_1m ${ref.symbol} → 15m (${hub.length} bars)${older.length ? ` + candles 15m (${older.length})` : ''}`,
  };
}
