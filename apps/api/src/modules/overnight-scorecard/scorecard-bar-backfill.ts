import { Logger } from '@nestjs/common';
import type { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import type { SaveCandleInput } from '../market-data/repositories/market-data.repository';
import type { BarBackfill } from './ports';
import type { ScorecardRepository } from './scorecard.repository';
import { istYmd } from './domain/windows';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3600_000;
/**
 * Calendar days fetched per timeframe. 1d: ~60 sessions (MACD needs 35; weekends and holidays are
 * the slack). 15m: ~4 sessions (≥ 35 bars at 25 a session); one broker call per day, so kept short.
 */
export const BACKFILL_DAYS: Record<'1d' | '15m', number> = { '1d': 95, '15m': 7 };
/** Before this IST hour today's daily bar may still be forming: it is not stored (it would never be corrected). */
const DAILY_SETTLED_HOUR_IST = 16;

/**
 * On-demand history for the scorecard's indicators factor (`candles` lacks daily rows for most NSE
 * cash names outside the daily-backfill universe). Fetches over the OWNER's own Angel session —
 * UserFeedManager.fetchCandles, the per-user path the MBM background jobs use (no login of its
 * own; the session paces every historical call at HISTORICAL_MIN_GAP_MS, Angel's 3 req/s) — and
 * persists into `candles` with MarketDataRepository.saveCandles (createMany + skipDuplicates, the
 * daily-backfill cron's write), so later runs read them from Postgres. At most one successful
 * fetch per underlying × timeframe × IST day. Throws on a broker/DB failure (the engine fails soft).
 */
export class ScorecardBarBackfill implements BarBackfill {
  private readonly logger = new Logger('ScorecardBarBackfill');
  private readonly done = new Map<string, string>();

  constructor(
    private readonly repo: Pick<ScorecardRepository, 'underlyingInstrument'>,
    private readonly feeds: Pick<UserFeedManager, 'fetchCandles'>,
    private readonly candles: { saveCandles(rows: SaveCandleInput[]): Promise<number> },
    private readonly userId: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fill(name: string, timeframe: '1d' | '15m'): Promise<number> {
    if (!this.userId) return 0;
    const now = this.now();
    const key = `${name}:${timeframe}`;
    const day = istYmd(now);
    if (this.done.get(key) === day) return 0;

    const inst = await this.repo.underlyingInstrument(name);
    if (!inst) return 0;
    const from = new Date(now.getTime() - BACKFILL_DAYS[timeframe] * DAY_MS);
    const rows = await this.feeds.fetchCandles(this.userId, inst.token, inst.exchange, timeframe, from, now);
    if (this.done.size > 500) this.done.clear();
    this.done.set(key, day);

    const settled = (rows ?? []).filter((c) => c.timestamp.getTime() + barMs(timeframe, c.timestamp) <= now.getTime());
    if (settled.length === 0) return 0;
    const saved = await this.candles.saveCandles(
      settled.map((c) => ({
        instrumentId: inst.id,
        timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number.isFinite(c.volume) ? c.volume : 0,
      })),
    );
    this.logger.log(`[scorecard] backfilled ${name} ${timeframe}: ${settled.length} bars fetched, ${saved} new`);
    return settled.length;
  }
}

/**
 * How long after its timestamp a bar counts as complete. 15m: its own 15 minutes. 1d (stamped at
 * IST midnight): settled from 16:00 IST that day, past the equity close.
 */
function barMs(timeframe: '1d' | '15m', ts: Date): number {
  if (timeframe === '15m') return 15 * 60_000;
  const istMidnight = Date.parse(`${istYmd(ts)}T00:00:00Z`) - IST_OFFSET_MS;
  return istMidnight + DAILY_SETTLED_HOUR_IST * 3600_000 - ts.getTime();
}
