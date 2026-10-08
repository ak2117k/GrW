import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { INDICES } from '@td/shared/constants';
import { JobRunnerService } from '../../common/job-registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { TradeTrackerService } from '../trade-tracker/services/trade-tracker.service';
import { PrismaCandleRepo } from './candles/candle-repository';
import type { CandlesResult, Timeframe } from './candles/candle.types';
import { istDay } from './candles/trading-calendar';
import { ManagerHubBroker } from './hub-broker';
import type { HubCandleSource } from './hub-candle-source';
import { HubEngine, type HubStatus } from './hub-engine';
import { LANE, refKey, type HubExchange, type InstrumentRef, type PriceResult, type Priority } from './hub.types';
import { SessionClock, type DateRange } from './session-clock';

const POSITION_REFRESH_MS = 60_000;
const CALENDAR_ALERT_MS = 24 * 60 * 60 * 1000;
const HUB_EXCHANGES = new Set<HubExchange>(['NSE', 'BSE', 'NFO', 'BFO', 'MCX']);
/** Job name in job_runs and /healthz/detail (health-detail.service.ts EXPECTED_JOBS). */
export const CANDLE_FIXUP_JOB = 'hub-candle-fixup';
/** Well above a full fix-up (3 Background-lane calls per instrument), well under the daily cadence. */
const CANDLE_FIXUP_LEASE_MS = 2 * 60 * 60 * 1000;

/** "2026-11-02:2027-03-08,2027-11-01:2028-03-13" → ranges. */
export function parseLateClose(raw: string | undefined): DateRange[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [from, to] = s.split(':');
      return { from, to };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to));
}

/**
 * SP1 market hub, M1: SHADOW. It prices a default context set and the owner's
 * open positions on the owner's shared session and reports metrics; no
 * existing consumer reads from it yet. Start is fire-and-forget: boot must
 * never wait on the broker.
 */
@Injectable()
export class MarketHubService implements OnModuleInit, OnModuleDestroy, HubCandleSource {
  private readonly logger = new Logger(MarketHubService.name);
  readonly session: SessionClock;
  private engine: HubEngine | null = null;
  private reason: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly manager: UserFeedManager,
    private readonly tracker: TradeTrackerService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunnerService,
  ) {
    this.session = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: parseLateClose(this.config.get<string>('hub.mcxLateClose')),
    });
  }

  onModuleInit(): void {
    if (!this.config.get<boolean>('hub.enabled')) {
      this.reason = 'disabled (MARKET_HUB_ENABLED is not true)';
      return;
    }
    const owner = this.config.get<string>('hub.ownerUserId');
    if (!owner) {
      this.reason = 'enabled but HUB_OWNER_USER_ID is not set';
      this.logger.error(`Market hub ${this.reason}`);
      return;
    }
    const defaults: InstrumentRef[] = [
      INDICES.NIFTY_50,
      INDICES.BANK_NIFTY,
      INDICES.FIN_NIFTY,
      INDICES.SENSEX,
    ].map((i) => ({ exchange: i.exchange as HubExchange, token: i.token, symbol: i.symbol }));
    const engine = new HubEngine({
      broker: new ManagerHubBroker(this.manager, owner),
      clock: this.session,
      cap: this.config.get<number>('hub.slotCap') ?? 50,
      defaults,
      candles: this.config.get<boolean>('hub.candlesEnabled')
        ? { repo: new PrismaCandleRepo(this.prisma) }
        : undefined,
    });
    this.engine = engine;
    void engine
      .start()
      .then(() => this.refreshPositions(owner))
      .catch((err) => this.logger.error(`Market hub start failed: ${err?.message ?? err}`));
    const refresh = setInterval(() => void this.refreshPositions(owner), POSITION_REFRESH_MS);
    const calendar = setInterval(() => this.checkCalendar(), CALENDAR_ALERT_MS);
    refresh.unref?.();
    calendar.unref?.();
    this.timers = [refresh, calendar];
    this.checkCalendar();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.engine?.stop();
  }

  disabledReason(): string | null {
    return this.reason;
  }

  status(): HubStatus | null {
    return this.engine ? this.engine.status() : null;
  }

  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult {
    return this.engine ? this.engine.price(ref, opts) : { kind: 'unavailable', reason: 'no-session' };
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  watch(ref: InstrumentRef, priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    return this.engine ? this.engine.watch(ref, priority, owner, ttlMs) : Promise.resolve();
  }

  unwatch(ref: InstrumentRef, owner: string): Promise<void> {
    return this.engine ? this.engine.unwatch(ref, owner) : Promise.resolve();
  }

  servesCharts(): boolean {
    return !!this.engine?.candlesEnabled && this.config.get<boolean>('hub.servesCharts') === true;
  }

  candles(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandlesResult> {
    if (!this.engine) return Promise.reject(new Error(`market hub is not running: ${this.reason ?? 'not started'}`));
    return this.engine.candles(ref, timeframe, from.getTime(), to.getTime(), LANE.INTERACTIVE);
  }

  /**
   * 00:15 IST Tue–Sat: replace the previous IST day's tick-built bars with the
   * broker's official 1m/1h/1d (spec §6.4). After the latest close (MCX 23:55),
   * with every exchange shut, so the Background lane runs at full budget.
   */
  @Cron('0 15 0 * * 2-6', { name: CANDLE_FIXUP_JOB, timeZone: 'Asia/Kolkata' })
  async nightlyCandleFixup(): Promise<void> {
    const day = istDay(Date.now() - 24 * 60 * 60 * 1000);
    try {
      // Through the job runner: leased (one instance) and recorded in job_runs, so a fix-up that
      // stops running shows in /healthz/detail. With candles off the run is recorded as a no-op
      // success, so the expected job never reads as "never ran" on a hub that has nothing to fix.
      await this.jobs.run(CANDLE_FIXUP_JOB, { ttlMs: CANDLE_FIXUP_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const engine = this.engine;
        if (!engine?.candlesEnabled) return;
        const r = await engine.runFixup(day);
        const log = r.failures > 0 ? this.logger.warn.bind(this.logger) : this.logger.log.bind(this.logger);
        log(`Candle fix-up ${day}: ${r.instruments} instrument(s), ${r.calls} call(s), ${r.failures} failure(s)`);
      });
    } catch (err) {
      this.logger.error(`Candle fix-up ${day} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async refreshPositions(owner: string): Promise<void> {
    if (!this.engine) return;
    try {
      const byUser = await this.tracker.openTrackerRefsByUser();
      const refs = (byUser.get(owner) ?? [])
        .filter((t) => HUB_EXCHANGES.has(t.exchange.toUpperCase() as HubExchange))
        .map((t) => ({
          exchange: t.exchange.toUpperCase() as HubExchange,
          token: t.token,
          symbol: t.token,
        }));
      await this.engine.setPositions(refs);
    } catch (err) {
      this.logger.warn(`Market hub position refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private checkCalendar(): void {
    const missing = this.session.calendarGap();
    if (missing !== null) {
      this.logger.error(
        `Market holiday list for ${missing} is missing — add it to MARKET_HOLIDAYS (market-holidays.service.ts)`,
      );
    }
  }
}
