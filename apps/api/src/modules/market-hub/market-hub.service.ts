import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { INDICES } from '@td/shared/constants';
import { JobRunnerService } from '../../common/job-registry';
import { retentionCutoff, retentionDaysFromEnv } from '../../common/utils/retention';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MarketDataRepository } from '../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { TradeTrackerService } from '../trade-tracker/services/trade-tracker.service';
import { GreeksCalculatorService } from '../options-chain/services/greeks-calculator.service';
import { PrismaCandleRepo } from './candles/candle-repository';
import { PrismaChainRepo } from './chain/chain-repository';
import type { ExtraTargetOutcome } from './chain/chain-service';
import type { CandlesResult, Timeframe } from './candles/candle.types';
import type { FixupReport } from './candles/candle-store';
import { istDay, istMidnight } from './candles/trading-calendar';
import { mergeLines, parseLineFutures, positionUnderlyingLines, resolveLineFutures } from './hub-lines';
import { ManagerHubBroker } from './hub-broker';
import type { HubCandleSource } from './hub-candle-source';
import { HubEngine, type HubStatus } from './hub-engine';
import { engineHubPrices, type HubConsumer, type HubOutcome, type HubPriceSource, type HubPrices } from './hub-prices';
import { LANE, isHubExchange, refKey, type HubExchange, type InstrumentRef, type PriceResult, type Priority } from './hub.types';
import { SessionClock, parseLateClose } from './session-clock';
import { isDerivative, resolveUnderlying } from './underlying';

const POSITION_REFRESH_MS = 60_000;
/** Re-resolve the lines' near-month futures (an expiry rolls the month; the master refreshes at 08:00 IST). */
const LINE_REFRESH_MS = 30 * 60_000;
const CALENDAR_ALERT_MS = 24 * 60 * 60 * 1000;
const MAX_UNDERLYING_CACHE = 1000;
/** HUB_PIN_POSITION_UNDERLYINGS: anything but 'false' / '0' / 'off' pins open stock options' underlyings (default on). */
export function pinPositionUnderlyings(raw: string | undefined = process.env.HUB_PIN_POSITION_UNDERLYINGS): boolean {
  return !['false', '0', 'off'].includes(String(raw ?? '').trim().toLowerCase());
}
/** The config key behind each consumer switch. */
const CONSUMER_FLAG: Record<HubConsumer, string> = {
  positions: 'hub.pricesPositions',
  tracks: 'hub.pricesTracks',
  browser: 'hub.servesBrowser',
  chain: 'hub.servesChain',
};
/** Job name in job_runs and /healthz/detail (health-detail.service.ts EXPECTED_JOBS). */
export const CANDLE_FIXUP_JOB = 'hub-candle-fixup';
/** Well above a full fix-up (3 Background-lane calls per instrument), well under the daily cadence. */
const CANDLE_FIXUP_LEASE_MS = 2 * 60 * 60 * 1000;
/** Job name in job_runs and /healthz/detail (health-detail.service.ts EXPECTED_JOBS). */
export const OI_PRUNE_JOB = 'hub-oi-prune';
const OI_PRUNE_LEASE_MS = 10 * 60 * 1000;

// Lives in session-clock.ts (pure) so the trade sentinel can parse the same
// HUB_MCX_LATE_CLOSE without importing this service; re-exported here.
export { parseLateClose };

const DEFAULT_CHAIN_STRIKES_AROUND = 20;

/** HUB_CHAIN_STRIKES_AROUND read defensively: a non-finite or < 1 value falls back to 20; else rounded down. */
export function chainStrikesAround(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CHAIN_STRIKES_AROUND;
}

/** A config integer ≥ `min`, rounded down; anything else (unset, '', NaN, below min) is `fallback`. */
export function configInt(raw: unknown, fallback: number, min: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * The OI core list: HUB_OI_CORE_UNDERLYINGS (comma-separated, upper-cased, de-duplicated), plus SENSEX
 * while HUB_OI_SENSEX_ENABLED is on. Prod sets the list explicitly, so SENSEX has its own switch.
 *
 * 2026-11-04: plus GOLD and SILVER (MCX bullion) while HUB_OI_BULLION_ENABLED is on. On the US-midterm
 * day oi_check for a GOLD channel call read "NO_DATA: no option chain in oi_snapshots" and the judge
 * had no chain; CRUDEOIL / NATURALGAS were captured through this same path all day. The capture is the
 * hub's REST quote path (3-minute OI snapshot job), never a feed slot.
 */
export function oiCoreUnderlyings(raw: string | undefined, sensex: boolean, bullion = false): string[] {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (sensex) names.push('SENSEX');
  if (bullion) names.push('GOLD', 'SILVER');
  return [...new Set(names)];
}

/** HUB_OI_BULLION_ENABLED: anything but 'false' / '0' / 'off' captures GOLD + SILVER chains (default on; 'false' = rollback). */
export function oiBullionEnabled(raw: string | undefined = process.env.HUB_OI_BULLION_ENABLED): boolean {
  return !['false', '0', 'off'].includes(String(raw ?? '').trim().toLowerCase());
}

/**
 * SP1 market hub. M1 (shadow): prices a default context set and the owner's
 * open positions on the owner's shared session and reports metrics; no
 * consumer reads those prices yet. M2: the CandleStore (tick-built 1m bars,
 * gap fill, nightly fix-up) runs behind HUB_CANDLES_ENABLED, and /candles is
 * answered from it behind HUB_SERVES_CHARTS. M3: prices the owner's positions
 * and the system-wide strategy tracks for consumers behind HUB_PRICES_POSITIONS /
 * HUB_PRICES_TRACKS through the HUB_PRICE_SOURCE token (see hub-prices.ts).
 * M4: feeds the owner's browser (the /ws gateway and the quote, depth, indices
 * and watchlist endpoints) behind HUB_SERVES_BROWSER.
 * M5: option chains (HubChains, through `hubFor(…, 'chain')`) behind HUB_SERVES_CHAIN, and 3-minute OI
 * snapshots behind HUB_OI_SNAPSHOT_ENABLED. 2026-10-29 widening: SENSEX in the core list
 * (HUB_OI_SENSEX_ENABLED), near-month NFO futures OI + LTP (HUB_OI_FUTURES_ENABLED) and the day's
 * stock-option call underlyings as narrow chains (HUB_OI_EXTRA_MAX_PER_DAY), all on by default.
 * Start is fire-and-forget: boot must never wait on the broker.
 */
@Injectable()
export class MarketHubService implements OnModuleInit, OnModuleDestroy, HubCandleSource, HubPriceSource {
  private readonly logger = new Logger(MarketHubService.name);
  readonly session: SessionClock;
  private engine: HubEngine | null = null;
  private reason: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private offOpenSet: (() => void) | null = null;
  private ownerUserId: string | null = null;
  private ownerHub: HubPrices | null = null;
  private readonly underlyings = new Map<string, InstrumentRef | null>();
  private indexLines: InstrumentRef[] = [];
  /** Line futures by master name (HUB_LINE_FUTURES), as last resolved. */
  private lineFutures = new Map<string, InstrumentRef>();
  /** Names last reported missing, so a missing future warns once per change, not every 30 min. */
  private lastMissingLines = '';
  /** Open stock-option positions' cash underlyings pinned as lines (hub-lines.ts positionUnderlyingLines). */
  private positionLines: InstrumentRef[] = [];

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
    const chainRepo = new PrismaChainRepo(this.prisma);
    const extraMax = configInt(this.config.get<unknown>('hub.oiExtraMaxPerDay'), 10, 0);
    const engine = new HubEngine({
      broker: new ManagerHubBroker(this.manager, owner),
      clock: this.session,
      cap: this.config.get<number>('hub.slotCap') ?? 50,
      defaults,
      candles: this.config.get<boolean>('hub.candlesEnabled')
        ? { repo: new PrismaCandleRepo(this.prisma) }
        : undefined,
      consumerFlags: () => ({
        positions: this.consumerEnabled('positions'),
        tracks: this.consumerEnabled('tracks'),
        browser: this.consumerEnabled('browser'),
        chain: this.consumerEnabled('chain'),
      }),
      chain: {
        repo: chainRepo,
        math: new GreeksCalculatorService(),
        strikesAround: chainStrikesAround(this.config.get<unknown>('hub.chainStrikesAround')),
        coreUnderlyings: oiCoreUnderlyings(
          this.config.get<string>('hub.oiCoreUnderlyings'),
          this.config.get<boolean>('hub.oiSensexEnabled') !== false,
          oiBullionEnabled(),
        ),
        snapshots: this.config.get<boolean>('hub.oiSnapshotEnabled') !== false,
        extra:
          extraMax > 0
            ? {
                maxPerDay: extraMax,
                strikesAround: configInt(this.config.get<unknown>('hub.oiExtraStrikesAround'), 5, 1),
                candidates: (since) => chainRepo.optionCallUnderlyings(since),
              }
            : undefined,
        futuresOi: this.config.get<boolean>('hub.oiFuturesEnabled') !== false ? { repo: chainRepo } : undefined,
        log: (m) => this.logger.warn(m),
      },
    });
    this.engine = engine;
    this.ownerUserId = owner;
    this.ownerHub = engineHubPrices(engine);
    // The index spots are lines as soon as the hub is up; their futures join once the master answers.
    this.indexLines = defaults;
    void engine
      .start()
      // setLines registers synchronously; the futures' master lookup must not wait on a slow broker.
      .then(() => Promise.all([this.refreshPositions(owner), engine.setLines(defaults), this.refreshLines()]))
      .catch((err) => this.logger.error(`Market hub start failed: ${err?.message ?? err}`));
    const refresh = setInterval(() => void this.refreshPositions(owner), POSITION_REFRESH_MS);
    const lines = setInterval(() => void this.refreshLines(), LINE_REFRESH_MS);
    // A reconcile that opened/closed one of the owner's trackers (order stream,
    // adaptive poll, cron) re-watches at once: a fresh position is priced from
    // its first seconds, and a closed one frees its slot, without waiting for
    // the 60 s refresh above (which stays as the backstop).
    this.offOpenSet =
      this.tracker.onOpenSetChanged?.((userId) => {
        if (userId === owner) void this.refreshPositions(owner);
      }) ?? null;
    const calendar = setInterval(() => this.checkCalendar(), CALENDAR_ALERT_MS);
    refresh.unref?.();
    lines.unref?.();
    calendar.unref?.();
    this.timers = [refresh, lines, calendar];
    this.checkCalendar();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.offOpenSet?.();
    this.offOpenSet = null;
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

  /**
   * See HubPriceSource.hubFor. Personal MVP: only the owner's hub exists.
   * `null` means the system-wide paper tracks; a browser always has a user, so
   * 'browser' never serves null.
   */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null {
    if (!this.engine || !this.ownerHub || !this.ownerUserId) return null;
    if (!this.consumerEnabled(consumer)) return null;
    if (userId === null && consumer === 'browser') return null;
    if (userId !== null && userId !== this.ownerUserId) return null;
    return this.ownerHub;
  }

  /**
   * Capture this stock's nearest-expiry option chain (±HUB_OI_EXTRA_STRIKES_AROUND) into oi_snapshots
   * every 3 minutes for the rest of the IST day — for a caller that knows of a stock-option call before
   * the next 3-minute poll of channel calls / open trades would. Capped per day; never throws.
   */
  async captureOptionChain(underlying: string): Promise<ExtraTargetOutcome> {
    const chains = this.engine?.chains;
    if (!chains) return 'off';
    try {
      return await chains.addExtraTarget(underlying);
    } catch (err) {
      this.logger.warn(`OI extra chain ${underlying} failed: ${(err as Error)?.message ?? err}`);
      return 'off';
    }
  }

  record(consumer: HubConsumer, outcome: HubOutcome, count = 1): void {
    this.engine?.recordConsumer(consumer, outcome, count);
  }

  private consumerEnabled(consumer: HubConsumer): boolean {
    return this.config.get<boolean>(CONSUMER_FLAG[consumer]) === true;
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
      await this.candleFixup(day);
    } catch (err) {
      this.logger.error(`Candle fix-up ${day} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * One fix-up of `day` (IST YYYY-MM-DD) — the nightly cron, or an admin run (POST
   * /api/admin/market-hub/fixup). Through the job runner: leased (one instance, so an admin run
   * never overlaps the cron) and recorded in job_runs. With candles off the run is a no-op success,
   * so the expected job never reads as "never ran" on a hub that has nothing to fix. Returns the
   * report (null when candles are off or another instance holds the lease).
   */
  async candleFixup(day: string): Promise<FixupReport | null> {
    return this.jobs.run(CANDLE_FIXUP_JOB, { ttlMs: CANDLE_FIXUP_LEASE_MS, onRedisError: 'run-anyway' }, async (): Promise<FixupReport | null> => {
      const engine = this.engine;
      if (!engine?.candlesEnabled) return null;
      const r = await engine.runFixup(day);
      // A fix-up that wrote no daily bar for a day with instruments did nothing, whatever the call count says.
      const silent = r.instruments > 0 && r.written['1d'] === 0;
      const log = r.failures > 0 || silent ? this.logger.warn.bind(this.logger) : this.logger.log.bind(this.logger);
      log(`Candle fix-up ${day}: ${fixupLine(r)}${silent ? ' — NO daily bar written' : ''}`);
      return r;
    });
  }

  /**
   * 02:45 IST daily: drop oi_snapshots older than OI_SNAPSHOT_RETENTION_DAYS. Unset / 0 (the
   * default) keeps them forever (owner decision 2026-10-21: OI history is training data). The
   * job still runs, as a no-op success, so /healthz/detail keeps seeing it; also a no-op without chains.
   */
  @Cron('0 45 2 * * *', { name: OI_PRUNE_JOB, timeZone: 'Asia/Kolkata' })
  async pruneOiSnapshots(): Promise<void> {
    try {
      await this.jobs.run(OI_PRUNE_JOB, { ttlMs: OI_PRUNE_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const chains = this.engine?.chains;
        if (!chains) return;
        const days = retentionDaysFromEnv(process.env.OI_SNAPSHOT_RETENTION_DAYS);
        const cutoff = retentionCutoff(days);
        if (!cutoff) return;
        const removed = await chains.pruneOi(cutoff);
        this.logger.log(`OI snapshot prune: ${removed} row(s) older than ${days} days removed`);
      });
    } catch (err) {
      this.logger.error(`OI snapshot prune failed: ${(err as Error)?.message ?? err}`);
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
      // 2026-11-04 (LAURUSLABS-EQ had 4 bars all session under an open option): the cash underlying of an
      // open stock option is a pinned line while the position is open. HUB_PIN_POSITION_UNDERLYINGS=false
      // (rollback) keeps it a plain P1 position watch, as before. Default on.
      const pinned = pinPositionUnderlyings()
        ? positionUnderlyingLines(underlyings, {
            base: mergeLines(this.indexLines, [...this.lineFutures.values()]),
            positions: refs.length,
            cap: this.config.get<number>('hub.slotCap') ?? 50,
          })
        : [];
      if (pinned.map(refKey).join(',') !== this.positionLines.map(refKey).join(',')) {
        this.positionLines = pinned;
        await this.engine.setLines(this.allLines());
      }
    } catch (err) {
      this.logger.warn(`Market hub position refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * The pinned lines (hub-lines.ts): the index spots + the near-month future of each
   * HUB_LINE_FUTURES name, resolved from the master the same way the engines pick it. On boot and
   * every 30 min (an expiry rolls the month). A failed lookup keeps the previous futures rather
   * than dropping them: a master blip must not unpin crude mid-session. Never throws.
   */
  async refreshLines(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    try {
      const names = parseLineFutures(this.config.get<string>('hub.lineFutures'));
      const today = new Date(istMidnight(istDay(Date.now())));
      const { found, missing } = await resolveLineFutures(
        names,
        (name, exchange, onOrAfter) => this.instruments.getNearestFuture(name, exchange, onOrAfter),
        today,
      );
      const missingKey = missing.join(',');
      if (missingKey !== this.lastMissingLines) {
        this.lastMissingLines = missingKey;
        if (missing.length > 0) this.logger.warn(`Market hub lines: no near-month future in the master for ${missingKey}`);
      }
      const next = new Map<string, InstrumentRef>();
      for (const [name, ref] of found) next.set(name, ref);
      for (const name of missing) {
        const prev = this.lineFutures.get(name);
        if (prev) next.set(name, prev); // a failed lookup keeps the last known future
      }
      this.lineFutures = next;
      await engine.setLines(this.allLines());
    } catch (err) {
      this.logger.warn(`Market hub line refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Index spots, then the line futures, then the pinned position underlyings — one entry per EXCHANGE:token. */
  private allLines(): InstrumentRef[] {
    return mergeLines(this.indexLines, [...this.lineFutures.values()], this.positionLines);
  }

  /** Memoised per contract (the master does not change intraday); a failure is not cached. */
  private async underlyingOf(ref: InstrumentRef): Promise<InstrumentRef | null> {
    const key = refKey(ref);
    if (this.underlyings.has(key)) return this.underlyings.get(key) ?? null;
    try {
      const { ref: underlying } = await resolveUnderlying(ref, {
        // A REUSED token (prod 2026-11-05: NFO 39982 = an expired COFORGE CE and the live NIFTY09NOV2624300CE)
        // must resolve to THIS contract: when the token row's tradingsymbol is another contract's, use the ref's own.
        contract: async (exchange, token) => {
          const byToken = await this.instruments.getInstrumentByToken(token, exchange);
          const rowSymbol = typeof byToken?.symbol === 'string' ? byToken.symbol.trim() : '';
          if (byToken && ref.symbol && rowSymbol !== '' && rowSymbol.toUpperCase() !== String(ref.symbol).trim().toUpperCase()) {
            return (await this.instruments.getInstrumentBySymbol(ref.symbol, exchange)) ?? byToken;
          }
          return byToken;
        },
        cash: (symbol, exchange) => this.instruments.getInstrumentBySymbol(symbol, exchange),
        // An MCX option's underlying is its month's future (the sentinel's pick): without this an
        // MCX position resolved to NO underlying and its future was never held.
        future: (name, exchange, contractExpiry) => this.nearestFutureFor(name, exchange, contractExpiry),
      });
      if (this.underlyings.size >= MAX_UNDERLYING_CACHE) this.underlyings.clear();
      this.underlyings.set(key, underlying);
      return underlying;
    } catch (err) {
      this.logger.warn(`Underlying lookup failed for ${ref.symbol} (${key}): ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /** The future of the contract's own month (expiring on/after it), else today's nearest — tick-source.adapter.ts's pick. */
  private async nearestFutureFor(name: string, exchange: string, contractExpiry: Date | null) {
    const today = new Date(istMidnight(istDay(Date.now())));
    if (contractExpiry && contractExpiry.getTime() > today.getTime()) {
      const own = await this.instruments.getNearestFuture(name, exchange, contractExpiry);
      if (own) return own;
    }
    return this.instruments.getNearestFuture(name, exchange, today);
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

/** "62 instrument(s), 186 call(s), 0 failure(s); fetched/written 1m 1200/1200, 1h 60/60, 1d 300/0; 4 empty window(s); sample …" */
export function fixupLine(r: FixupReport): string {
  const t = (k: '1m' | '1h' | '1d') => `${k} ${r.fetched[k]}/${r.written[k]}`;
  const s = r.samples[0];
  const sample = s ? `; sample ${s.ref} ${s.table} [${s.from}, ${s.to}) fetched ${s.fetched} kept ${s.kept}${s.firstTs ? ` first ${s.firstTs} last ${s.lastTs}` : ''}` : '';
  return (
    `${r.instruments} instrument(s), ${r.calls} call(s), ${r.failures} failure(s); fetched/written ${t('1m')}, ${t('1h')}, ${t('1d')}; ` +
    `${r.emptyWindows} empty window(s)${sample}`
  );
}
