import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LevelBookService, getTodayMidnightIstAsUtc } from './level-book.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TIMEFRAMES } from '@td/shared/constants';
import { DailyBackfillWorker } from '../../market-data/workers/daily-backfill.worker';

/**
 * Index tokens are stable (NIFTY = 99926000 forever) so we hardcode them.
 * MCX commodity tokens roll monthly — leave them token-less and the cron
 * resolves the current front-month from the DB by (symbol, exchange) at
 * run time. The roll script keeps that DB row pointing at whatever the
 * active contract is.
 */
const UNIVERSE: Array<{ token?: string; symbol: string; exchange: string }> = [
  // Indices — stable tokens
  { token: '99926000', symbol: 'NIFTY', exchange: 'NSE' },
  { token: '99926009', symbol: 'BANKNIFTY', exchange: 'NSE' },
  { token: '99926037', symbol: 'FINNIFTY', exchange: 'NSE' },
  // MCX commodities — token resolved from DB (front-month rolls monthly)
  { symbol: 'CRUDEOIL', exchange: 'MCX' },
  { symbol: 'COPPER', exchange: 'MCX' },
];

@Injectable()
export class LevelBookCron implements OnModuleInit {
  private readonly logger = new Logger(LevelBookCron.name);

  constructor(
    private readonly levelBook: LevelBookService,
    private readonly prisma: PrismaService,
    // Optional so unit-test wiring (which doesn't bring up MarketDataModule)
    // still constructs cleanly. Production always has it.
    @Optional() private readonly dailyBackfill?: DailyBackfillWorker,
  ) {}

  /**
   * Seed level books at boot. Without this, an API restart between
   * 09:15 IST cron firings (e.g. mid-session restart) leaves all
   * universe books empty until the next morning. With it, every
   * universe symbol has a populated, live-fed book the moment the
   * service boots — so the /signals/analyze endpoint and the chart
   * analysis panel work immediately.
   *
   * Universe catch-up backfill runs FIRST so seedSession reads the
   * freshest possible "last daily before today" candle for each
   * symbol AND the analyze endpoint sees recent intraday candles for
   * its `take: 25` fast-path read. Without this step, a boot after
   * the API was offline at 15:35 / 23:35 IST would leave NSE OR MCX
   * candles missing — PDH/PDL goes stale (multi-day-old daily) AND
   * intraday queries return 0 candles ("got 0, need 25") until
   * tomorrow's cron firings. Covers both NSE indices and MCX
   * commodities across 1d/1h/15m/5m.
   */
  async onModuleInit(): Promise<void> {
    if (this.dailyBackfill) {
      try {
        await this.dailyBackfill.backfillUniverseAtBoot();
      } catch (err) {
        this.logger.warn(
          `Boot universe-backfill failed (continuing with seed anyway): ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log('Boot-seeding level books');
    await this.seedSession();
    await this.lockOpeningRange();
  }

  /** 09:15 IST Mon-Fri — seed PDH/PDL/ATR for the day's universe. */
  @Cron('0 15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async seedSession(): Promise<void> {
    this.logger.log('Seeding level books for the session');
    // Threshold for "yesterday or earlier" daily candles. Without this filter,
    // an API restart after 15:35 IST (when the daily-backfill cron writes
    // today's daily candle) would silently flip PDH/PDL to today's H/L,
    // because Angel One stamps daily candles at midnight IST of the trading
    // day — see getTodayMidnightIstAsUtc() for the full rationale.
    const todayMidnightUtc = getTodayMidnightIstAsUtc();
    for (const u of UNIVERSE) {
      try {
        // Resolve token from DB when not hardcoded (MCX commodities roll
        // monthly; the roll script keeps the DB row's token current).
        const where = u.token
          ? { token: u.token, exchange: u.exchange }
          : { symbol: u.symbol, exchange: u.exchange };
        const inst = await this.prisma.instrument.findFirst({
          where,
          select: { id: true, token: true },
        });
        if (!inst) {
          this.logger.warn(`No instrument row for ${u.symbol}; skipping`);
          continue;
        }
        const resolvedToken = inst.token;
        const recent = await this.prisma.candle.findMany({
          where: {
            instrumentId: inst.id,
            timeframe: TIMEFRAMES.DAILY,
            timestamp: { lt: todayMidnightUtc },
          },
          orderBy: { timestamp: 'desc' },
          take: 16,
        });
        if (recent.length === 0) {
          this.logger.warn(`No daily candles for ${u.symbol}; skipping`);
          continue;
        }
        this.levelBook.seedSession({
          token: resolvedToken, symbol: u.symbol, exchange: u.exchange,
          recentDailyCandles: recent
            .reverse()
            .map((c) => ({
              timestamp: c.timestamp,
              open: c.open, high: c.high, low: c.low, close: c.close,
              volume: Number(c.volume),
            })),
        });
        this.levelBook.markAsLive(resolvedToken);
        await this.levelBook.replaySessionToBook(resolvedToken, u.exchange, inst.id);
      } catch (err) {
        this.logger.error(
          `seedSession ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`Seeded ${UNIVERSE.length} level books`);
  }

  /**
   * 09:16 IST Mon-Fri — earliest OR lock for MCX (first 15 min ends
   * 09:15; +1 min buffer for the aggregator to flush the closed bar).
   * NSE entries are skipped silently here because their OR candle
   * (09:15-09:30) hasn't been written yet.
   */
  @Cron('0 16 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async lockOpeningRangeMcx(): Promise<void> {
    await this.lockOpeningRange();
  }

  /**
   * 09:30 IST Mon-Fri — lock OR for NSE (first 15 min = 09:15-09:30).
   * Also catches any MCX entries that missed the 09:15 firing (idempotent).
   */
  @Cron('0 30 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async lockOpeningRange(): Promise<void> {
    this.logger.log('Locking opening ranges');
    for (const u of UNIVERSE) {
      try {
        const where = u.token
          ? { token: u.token, exchange: u.exchange }
          : { symbol: u.symbol, exchange: u.exchange };
        const inst = await this.prisma.instrument.findFirst({
          where,
          select: { id: true, token: true },
        });
        if (!inst) continue;
        const resolvedToken = inst.token;
        // OR candle = first 15 min of the session.
        // NSE opens 09:15 IST → OR candle starts 03:45 UTC.
        // MCX opens 09:00 IST → OR candle starts 03:30 UTC.
        const today = new Date();
        if (u.exchange === 'MCX') {
          today.setUTCHours(3, 30, 0, 0);
        } else {
          today.setUTCHours(3, 45, 0, 0);
        }
        const tomorrow = new Date(today);
        tomorrow.setUTCMinutes(today.getUTCMinutes() + 15);
        const orCandle = await this.prisma.candle.findFirst({
          where: {
            instrumentId: inst.id,
            timeframe: TIMEFRAMES.FIFTEEN_MIN,
            timestamp: { gte: today, lt: tomorrow },
          },
        });
        if (!orCandle) {
          this.logger.warn(`No OR 15m candle for ${u.symbol} yet; skipping`);
          continue;
        }
        this.levelBook.lockOpeningRange(resolvedToken, {
          high: orCandle.high, low: orCandle.low,
        });
      } catch (err) {
        this.logger.error(
          `lockOpeningRange ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
