import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { INDICES } from '@td/shared/constants';
import { JobRunnerService } from '../../common/job-registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MarketDataRepository } from '../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { TradeTrackerService } from '../trade-tracker/services/trade-tracker.service';
import { PrismaCandleRepo } from './candles/candle-repository';
import type { CandlesResult, Timeframe } from './candles/candle.types';
import { istDay } from './candles/trading-calendar';
import { ManagerHubBroker } from './hub-broker';
import type { HubCandleSource } from './hub-candle-source';
import { HubEngine, type HubStatus } from './hub-engine';
import { engineHubPrices, type HubConsumer, type HubOutcome, type HubPriceSource, type HubPrices } from './hub-prices';
import { LANE, isHubExchange, refKey, type HubExchange, type InstrumentRef, type PriceResult, type Priority } from './hub.types';
import { SessionClock, type DateRange } from './session-clock';
import { isDerivative, resolveUnderlying } from './underlying';

const POSITION_REFRESH_MS = 60_000;
const CALENDAR_ALERT_MS = 24 * 60 * 60 * 1000;
const MAX_UNDERLYING_CACHE = 1000;
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
 * SP1 market hub. M1 (shadow): prices a default context set and the owner's
 * open positions on the owner's shared session and reports metrics; no
 * consumer reads those prices yet. M2: the CandleStore (tick-built 1m bars,
 * gap fill, nightly fix-up) runs behind HUB_CANDLES_ENABLED, and /candles is
 * answered from it behind HUB_SERVES_CHARTS. M3: prices the owner's positions
 * and the system-wide strategy tracks for consumers behind HUB_PRICES_POSITIONS /
 * HUB_PRICES_TRACKS through the HUB_PRICE_SOURCE token (see hub-prices.ts).
 * Start is fire-and-forget: boot must never wait on the broker.
 */
@Injectable()
export class MarketHubService implements OnModuleInit, OnModuleDestroy, HubCandleSource, HubPriceSource {
  private readonly logger = new Logger(MarketHubService.name);
  readonly session: SessionClock;
  private engine: HubEngine | null = null;
  private reason: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private ownerUserId: string | null = null;
  private ownerHub: HubPrices | null = null;
  private readonly underlyings = new Map<string, InstrumentRef | null>();

  constructor(
    private readonly config: ConfigService,
    private readonly manager: UserFeedManager,
    private readonly tracker: TradeTrackerService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunnerService,
    private readonly instruments: MarketDataRepository,
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
    this.ownerUserId = owner;
    this.ownerHub = engineHubPrices(engine);
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

  /** See HubPriceSource.hubFor. Personal MVP: only the owner's hub exists. */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null {
    if (!this.engine || !this.ownerHub || !this.ownerUserId) return null;
    if (!this.consumerEnabled(consumer)) return null;
    if (userId !== null && userId !== this.ownerUserId) return null;
    return this.ownerHub;
  }

  record(consumer: HubConsumer, outcome: HubOutcome, count = 1): void {
    this.engine?.recordConsumer(consumer, outcome, count);
  }

  private consumerEnabled(consumer: HubConsumer): boolean {
    const key = consumer === 'positions' ? 'hub.pricesPositions' : 'hub.pricesTracks';
    return this.config.get<boolean>(key) === true;
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

  /**
   * The owner's open positions at priority 0 with their real tradingsymbols,
   * and each derivative's underlying at priority 1 (spec §5.1). A failed
   * underlying lookup never drops the position itself.
   */
  private async refreshPositions(owner: string): Promise<void> {
    if (!this.engine) return;
    try {
      const byUser = await this.tracker.openPositionRefsByUser();
      const refs: InstrumentRef[] = [];
      for (const p of byUser.get(owner) ?? []) {
        const exchange = p.exchange.toUpperCase();
        if (!isHubExchange(exchange)) continue;
        refs.push({ exchange, token: p.token, symbol: p.symbol });
      }
      const underlyings: InstrumentRef[] = [];
      for (const r of refs) {
        if (!isDerivative(r)) continue;
        const u = await this.underlyingOf(r);
        if (u) underlyings.push(u);
      }
      await this.engine.setPositions(refs, underlyings);
    } catch (err) {
      this.logger.warn(`Market hub position refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Memoised per contract (the master does not change intraday); a failure is not cached. */
  private async underlyingOf(ref: InstrumentRef): Promise<InstrumentRef | null> {
    const key = refKey(ref);
    if (this.underlyings.has(key)) return this.underlyings.get(key) ?? null;
    try {
      const { ref: underlying } = await resolveUnderlying(ref, {
        contract: (exchange, token) => this.instruments.getInstrumentByToken(token, exchange),
        cash: (symbol, exchange) => this.instruments.getInstrumentBySymbol(symbol, exchange),
      });
      if (this.underlyings.size >= MAX_UNDERLYING_CACHE) this.underlyings.clear();
      this.underlyings.set(key, underlying);
      return underlying;
    } catch (err) {
      this.logger.warn(`Underlying lookup failed for ${ref.symbol} (${key}): ${(err as Error)?.message ?? err}`);
      return null;
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
