import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StrongZoneDetectorService } from '../signal-generator/services/strong-zone-detector.service';
import {
  aggregateBars,
  atr14,
  breakOutcome,
  detectBreaks,
  istAt,
  istDay,
  oiAround,
  SESSION_CLOSE_MIN,
  type Bar,
  type DetectedBreak,
} from './domain/level-break.logic';

export const LEVEL_BREAK_INSTRUMENT = 'NIFTY';
/** mbm_bars_1m series holding NIFTY spot 1-minute bars. */
const BAR_SERIES = 'NIFTY';
/** Timeframes logged, with the calendar-day lookback that yields ≥ ~200 bars for the zone detector. */
export const LEVEL_BREAK_TIMEFRAMES: ReadonlyArray<{ tf: string; minutes: number; lookbackDays: number }> = [
  { tf: '15m', minutes: 15, lookbackDays: 16 },
  { tf: '60m', minutes: 60, lookbackDays: 45 },
];
const MIN_BARS = 30;
/** Give up on a row whose session bars never arrived (holiday data hole, feed outage). */
const GIVE_UP_MS = 3 * 86_400_000;

/**
 * Level-break research log (see domain/level-break.logic.ts). Reads mbm_bars_1m + nifty_oi_history,
 * writes level_break_log. FAIL-SOFT and inert for trading: no other module reads its table, every
 * error is logged and swallowed. Disable with LEVEL_BREAK_LOG=off.
 *
 * Zones come from the app's own StrongZoneDetectorService (a private instance, so the shared
 * trading-path cache is never touched), computed on the bars BEFORE the break bar.
 */
@Injectable()
export class LevelBreakLogService {
  private readonly logger = new Logger(LevelBreakLogService.name);
  private readonly detector = new StrongZoneDetectorService();

  constructor(private readonly prisma: PrismaService) {}

  get enabled(): boolean {
    return (process.env.LEVEL_BREAK_LOG ?? 'on').trim().toLowerCase() !== 'off';
  }

  /** One minute after each 15-min bar closes (09:31 … 15:31 IST); 60m bars close at :15 and 15:30. */
  @Cron('0 1,16,31,46 9-15 * * 1-5', { name: 'level-break-log-detect', timeZone: 'Asia/Kolkata' })
  async detectCron(): Promise<void> {
    if (!this.enabled) return;
    await this.detect(new Date());
  }

  @Cron('0 5,35 9-23 * * 1-5', { name: 'level-break-log-outcomes', timeZone: 'Asia/Kolkata' })
  async outcomesCron(): Promise<void> {
    if (!this.enabled) return;
    await this.fillOutcomes(new Date());
  }

  /** Detects breaks on the most recently closed bar of each timeframe and logs them. Returns rows written. */
  async detect(now: Date): Promise<number> {
    let written = 0;
    for (const t of LEVEL_BREAK_TIMEFRAMES) {
      try {
        const bars1m = await this.bars(new Date(now.getTime() - t.lookbackDays * 86_400_000), now);
        const have = new Set(bars1m.map((b) => b.ts));
        // A bucket counts only once its LAST 1-minute bar has landed (the bar refresher can lag a
        // few minutes); otherwise its close would be a partial one.
        const tfBars = aggregateBars(bars1m, t.minutes, now.getTime()).filter((b) => have.has(b.end - 60_000));
        if (tfBars.length < MIN_BARS) continue;
        // The last two complete bars, so a bar whose data landed late is still seen on the next run;
        // the unique key dedupes. Stale bars (holiday, feed gap) are not re-logged.
        for (let i = Math.max(MIN_BARS - 1, tfBars.length - 2); i < tfBars.length; i++) {
          const bar = tfBars[i];
          if (now.getTime() - bar.end > (2 * t.minutes + 15) * 60_000) continue;
          const history = tfBars.slice(0, i);
          const prev = history[history.length - 1];
          const atr = atr14(history);
          if (!atr) continue;
          this.detector.clearCache();
          const zones = this.detector.detectZones({
            token: `level-break-log:${LEVEL_BREAK_INSTRUMENT}`,
            symbol: LEVEL_BREAK_INSTRUMENT,
            exchange: 'NSE',
            interval: t.tf,
            candles15m: history.map((b) => ({ timestamp: new Date(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
            ltp: prev.close,
            atr14: atr,
          });
          const breaks = detectBreaks(zones, prev, bar, atr);
          if (breaks.length) written += await this.write(t.tf, breaks);
        }
      } catch (err) {
        this.logger.warn(`[level-break-log] ${t.tf} detect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return written;
  }

  /** Fills the follow-through (and any OI the backfill had not yet captured) on open rows. */
  async fillOutcomes(now: Date, limit = 200): Promise<{ filled: number; pending: number }> {
    let filled = 0;
    let pending = 0;
    try {
      const rows = await this.prisma.levelBreakLog.findMany({
        where: { outcomeFilledAt: null, ts: { lte: new Date(now.getTime() - 15 * 60_000) } },
        orderBy: { ts: 'asc' },
        take: limit,
      });
      const dayCache = new Map<string, Bar[]>();
      for (const r of rows) {
        try {
          const t = r.ts.getTime();
          const day = istDay(t - 1);
          if (!dayCache.has(day)) {
            dayCache.set(day, await this.bars(new Date(istAt(t - 1, 9 * 60)), new Date(istAt(t - 1, SESSION_CLOSE_MIN))));
          }
          const o = breakOutcome({ ts: t, price: r.price, direction: r.direction === 'DOWN' ? 'DOWN' : 'UP' }, dayCache.get(day)!);
          const oi = r.futOiNow === null || r.futOi15mBefore === null ? await this.futuresOi(t) : null;
          const giveUp = now.getTime() - t > GIVE_UP_MS;
          await this.prisma.levelBreakLog.update({
            where: { id: r.id },
            data: {
              priceAt15m: o.priceAt15m,
              priceAt60m: o.priceAt60m,
              priceEod: o.priceEod,
              move15mPts: o.move15mPts,
              move60mPts: o.move60mPts,
              moveEodPts: o.moveEodPts,
              mfeEodPts: o.mfeEodPts,
              maeEodPts: o.maeEodPts,
              ...(oi && oi.now !== null ? { futToken: oi.token, futOiNow: oi.now, futOi15mBefore: oi.before15m, futOiChange: oi.change } : {}),
              ...(o.complete || giveUp ? { outcomeFilledAt: now } : {}),
            },
          });
          if (o.complete || giveUp) filled++;
          else pending++;
        } catch (err) {
          this.logger.warn(`[level-break-log] outcome ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.logger.warn(`[level-break-log] outcomes failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { filled, pending };
  }

  private async write(tf: string, breaks: DetectedBreak[]): Promise<number> {
    const oi = await this.futuresOi(breaks[0].ts);
    const res = await this.prisma.levelBreakLog.createMany({
      data: breaks.map((b) => ({
        instrument: LEVEL_BREAK_INSTRUMENT,
        timeframe: tf,
        direction: b.direction,
        ts: new Date(b.ts),
        level: b.level,
        zoneType: b.zone.type,
        zoneUpper: b.zone.upper,
        zoneLower: b.zone.lower,
        classification: b.zone.classification,
        touchCount: b.zone.touchCount,
        atr: b.atr,
        price: b.price,
        futToken: oi?.token ?? null,
        futOiNow: oi?.now ?? null,
        futOi15mBefore: oi?.before15m ?? null,
        futOiChange: oi?.change ?? null,
      })),
      skipDuplicates: true,
    });
    if (res.count) this.logger.log(`[level-break-log] ${tf}: ${res.count} NIFTY break(s) logged`);
    return res.count;
  }

  private async bars(from: Date, to: Date): Promise<Bar[]> {
    const rows = await this.prisma.mbmBar1m.findMany({
      where: { series: BAR_SERIES, ts: { gte: from, lte: to } },
      orderBy: { ts: 'asc' },
      select: { ts: true, open: true, high: true, low: true, close: true, volume: true },
    });
    return rows.map((r) => ({ ts: r.ts.getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }

  /** Front-month NIFTY future (nearest expiry on/after the break's IST day) 5-min OI around `t`. */
  private async futuresOi(t: number): Promise<{ token: string; now: number | null; before15m: number | null; change: number | null } | null> {
    try {
      const rows = await this.prisma.niftyOiHistory.findMany({
        where: {
          kind: 'FUT',
          interval: 'FIVE_MINUTE',
          expiry: { gte: new Date(`${istDay(t - 1)}T00:00:00Z`) },
          ts: { gte: new Date(t - 45 * 60_000), lte: new Date(t) },
        },
        orderBy: [{ expiry: 'asc' }, { ts: 'asc' }],
        select: { token: true, expiry: true, ts: true, oi: true },
      });
      if (!rows.length) return null;
      const front = rows[0].expiry.getTime();
      const series = rows.filter((r) => r.expiry.getTime() === front);
      const o = oiAround(series.map((r) => ({ ts: r.ts.getTime(), oi: r.oi })), t);
      return {
        token: series[0].token,
        now: o.now,
        before15m: o.before15m,
        change: o.now !== null && o.before15m !== null ? o.now - o.before15m : null,
      };
    } catch (err) {
      this.logger.warn(`[level-break-log] futures OI read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
