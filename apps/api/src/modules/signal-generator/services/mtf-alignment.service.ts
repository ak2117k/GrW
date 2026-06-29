import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

export type TfDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type Timeframe = '1d' | '1h' | '15m' | '5m';

export interface MtfResult {
  directions: Record<Timeframe, TfDirection>;
  aligned: boolean;
  agreedDirection: 'UP' | 'DOWN' | null;
  /** Human-readable summary, e.g. "1d=UP 1h=DOWN 15m=UP 5m=UP". */
  summary: string;
}

interface Candle {
  timestamp: Date;
  close: number;
}

const TIMEFRAMES: Timeframe[] = ['1d', '1h', '15m', '5m'];
const RATE_LIMIT_MS = 350;

const LOOKBACK_MS: Record<Timeframe, number> = {
  '1d': 7 * 24 * 60 * 60 * 1000,
  '1h': 24 * 60 * 60 * 1000,
  '15m': 3 * 60 * 60 * 1000,
  '5m': 1 * 60 * 60 * 1000,
};

@Injectable()
export class MtfAlignmentService {
  private readonly logger = new Logger(MtfAlignmentService.name);

  constructor(private readonly adapter: AngelOneAdapterService) {}

  async check(token: string, exchange: string): Promise<MtfResult> {
    const directions: Record<Timeframe, TfDirection> = {
      '1d': 'NEUTRAL',
      '1h': 'NEUTRAL',
      '15m': 'NEUTRAL',
      '5m': 'NEUTRAL',
    };

    const now = Date.now();
    for (let i = 0; i < TIMEFRAMES.length; i++) {
      const tf = TIMEFRAMES[i];
      directions[tf] = await this.directionForTimeframe(token, exchange, tf, now);
      if (i < TIMEFRAMES.length - 1) await this.sleep(RATE_LIMIT_MS);
    }

    // Two-tier alignment:
    //
    //  TIER A (primary): 1d AND 1h both have the same non-NEUTRAL direction.
    //  This is the strongest signal — longer timeframes carry more weight
    //  than 15m/5m noise. Most gap-up scanners produce hits that look like
    //  `1d=UP 1h=UP 15m=DOWN 5m=DOWN` (gap-up overnight + intraday pullback
    //  on open). The old "no UP/DOWN conflict" rule rejected these — but
    //  the 1d+1h consensus says the bigger trend is UP, and analyze()'s
    //  own deeper gates (regime, R:R, round-numbers) should make the final
    //  call, not us rejecting at the structural level.
    //
    //  TIER B (fallback for swing setups): no Tier A agreement, but ≥2 of
    //  the 4 TFs have an opinion and they all agree (no UP-vs-DOWN
    //  conflict). This is the prior rule, kept for cases where 1d/1h are
    //  NEUTRAL but 15m+5m agree (e.g., low-volume stock with sparse
    //  daily/hourly data).
    const d1d = directions['1d'];
    const d1h = directions['1h'];
    const primaryAlignedUp = d1d === 'UP' && d1h === 'UP';
    const primaryAlignedDown = d1d === 'DOWN' && d1h === 'DOWN';
    const primaryAligned = primaryAlignedUp || primaryAlignedDown;

    const values = Object.values(directions);
    const upCount = values.filter((d) => d === 'UP').length;
    const downCount = values.filter((d) => d === 'DOWN').length;
    const opinionatedCount = upCount + downCount;
    // TIER B accepts >= 1 opinionated TF with no opposing direction.
    // (Was >= 2 previously — too strict; combined with the bug that returned
    // NEUTRAL on equal-close consecutive bars, it rejected genuinely uptrending
    // breakouts from consolidation. NEUTRAL now only means "data unavailable",
    // so a single UP with no DOWN is real signal, not absence of signal.)
    const secondaryAligned = opinionatedCount >= 1 && (upCount === 0 || downCount === 0);

    const aligned = primaryAligned || secondaryAligned;
    const agreedDirection: 'UP' | 'DOWN' | null = !aligned
      ? null
      : primaryAlignedUp
        ? 'UP'
        : primaryAlignedDown
          ? 'DOWN'
          : upCount > 0
            ? 'UP'
            : 'DOWN';

    const summary = TIMEFRAMES.map((tf) => `${tf}=${directions[tf]}`).join(' ');

    return { directions, aligned, agreedDirection, summary };
  }

  private async directionForTimeframe(
    token: string,
    exchange: string,
    tf: Timeframe,
    nowMs: number,
  ): Promise<TfDirection> {
    const from = new Date(nowMs - LOOKBACK_MS[tf]);
    const to = new Date(nowMs);

    let candles: Candle[];
    try {
      candles = (await this.adapter.getHistoricalData(
        token,
        exchange,
        tf,
        from,
        to,
      )) as Candle[];
    } catch (err) {
      this.logger.warn(
        `MTF: ${tf} fetch failed for ${exchange}:${token} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 'NEUTRAL';
    }

    if (!candles || candles.length < 2) return 'NEUTRAL';

    let endIdx = candles.length - 1;
    if (this.isBarStillForming(candles[endIdx], nowMs)) {
      endIdx -= 1;
    }
    if (endIdx < 1) return 'NEUTRAL';

    // Compare current close to the most recent DIFFERENT close. Real stocks
    // always move at least one tick over any window; equal-close consecutive
    // bars are tick-size coincidences, not "neutral" — walk back until we
    // find a different close and use that as the reference. NEUTRAL only
    // means "data missing" now, not "no opinion".
    const cur = candles[endIdx].close;
    let refIdx = endIdx - 1;
    while (refIdx >= 0 && candles[refIdx].close === cur) refIdx--;
    if (refIdx < 0) {
      // Every bar in the window had identical close — vanishingly rare for any
      // real instrument across a multi-bar window. Treat as data anomaly.
      return 'NEUTRAL';
    }
    return cur > candles[refIdx].close ? 'UP' : 'DOWN';
  }

  /**
   * A candle is treated as "still forming" only when its open-time is in
   * the future relative to our wall clock. Angel One's getCandleData
   * already returns completed historical bars stamped at bar-open time;
   * the only way we see a future-timestamped bar is when a caller mocks
   * one in (e.g. unit tests) or — in production — clock skew between
   * the API server and Angel's edge. We deliberately do NOT treat
   * "bar opened less than one timeframe ago" as still forming because
   * the historical endpoint will not return an in-progress bar in that
   * window; the most recent bar it returns is the previous completed
   * one. Trying to be too clever here drops a real signal on intraday
   * runs.
   */
  private isBarStillForming(bar: Candle, nowMs: number): boolean {
    return bar.timestamp.getTime() > nowMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
