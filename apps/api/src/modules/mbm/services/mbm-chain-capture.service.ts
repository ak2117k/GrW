// apps/api/src/modules/mbm/services/mbm-chain-capture.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { WarnLimiter } from '../../../common/utils/warn-limiter';
import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import type { OptionGreekRow } from '../../market-hub/chain/chain.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import type { NseCalendar } from '../domain/bar-window';
import {
  CHAIN_EXPIRIES,
  CHAIN_STRIKES_AROUND,
  SESSION_TICKS,
  baselineFrom,
  buildChainSnapshot,
  isChainCaptureTick,
  istYmd,
  strikesAround,
  type CaptureContract,
  type ChainSnapshotRow,
} from '../domain/chain-snapshot';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';
import { MbmChainRepository } from '../repositories/mbm-chain.repository';
import { MBM_CALENDAR, MBM_NOW } from './mbm-bar-refresher.service';
import { MbmCaptureLane } from './mbm-capture-lane';

/** Test seam for the gap between broker calls (and the throttle back-off). */
export const MBM_CHAIN_SLEEP = Symbol('MBM_CHAIN_SLEEP');
/** Test seam for the per-call timeout: resolves when the call has waited too long. */
export const MBM_CHAIN_TIMER = Symbol('MBM_CHAIN_TIMER');

/** Angel marketData FULL takes at most 50 tokens per call (the hub's QuoteBatcher uses the same cap). */
export const QUOTE_BATCH_MAX = 50;
/** Gap between this tick's broker calls: ≤ ~3/s, far under Angel's 10 req/s quote limit. */
export const CALL_GAP_MS = 350;
/** An index 1m close younger than this centres the strike window (stored: no broker call). */
export const SPOT_FRESH_MS = 10 * 60_000;
/** A day with fewer distinct ticks than this share of SESSION_TICKS logs its summary as a warning. */
export const DAY_OK_SHARE = 0.9;
/** A throttled quote batch is retried this many times, after THROTTLE_RETRY_MS × attempt (the bar refresher's rule). */
export const THROTTLE_RETRIES = 2;
export const THROTTLE_RETRY_MS = 3000;
/**
 * One broker call (including the session's own connect / re-login wait inside it) longer than this is
 * abandoned: the tick is skipped with reason `timeout` instead of hanging and silently eating the
 * following ticks through the single-flight guard.
 */
export const CALL_TIMEOUT_MS = 20_000;
/** A tick still "running" after this is treated as stuck: logged, and the next tick starts anyway. */
export const TICK_STALE_MS = 4 * 60_000;
/** Each skip reason logs once per instrument per this window (the count keeps going up). */
export const SKIP_LOG_WINDOW_MS = 30 * 60_000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);

/** Why a tick (or one instrument / expiry of it) stored nothing. Counted per day and printed at 15:40. */
export type SkipReason =
  | 'overlap'
  | 'stuck'
  | 'throttled'
  | 'timeout'
  | 'no-expiries'
  | 'no-spot'
  | 'no-legs'
  | 'not-tried'
  | 'duplicate'
  | 'error';

export class CaptureTimeoutError extends Error {}

/** A tick-level failure that also ends the rest of the tick (the session is not answering). */
const endsTick = (e: unknown) => e instanceof AngelThrottleError || e instanceof CaptureTimeoutError;

export interface CaptureSummary {
  ran: boolean;
  stored: number;
  /** Broker calls this tick made (quote batches incl. retries + greek calls + any index candle window). */
  calls: number;
  /** Per-instrument failure messages joined with '; ' (one failing instrument: just its message). */
  error?: string;
  /** Why nothing was stored when `ran` is false but the tick was due (overlap). */
  reason?: SkipReason;
}

const idle: CaptureSummary = { ran: false, stored: 0, calls: 0 };

interface DayTally {
  ok: number;
  failed: number;
  lastError?: string;
  reasons: Map<SkipReason, number>;
}

/**
 * Index option-chain capture (MBM_CHAIN_CAPTURE=on; MBM_CHAIN_CAPTURE_INSTRUMENTS, default NIFTY,BANKNIFTY):
 * every 5 min at second 40, 09:15–15:30 IST on NSE trading days, per instrument the nearest two expiries ×
 * ATM ±15 strikes × CE/PE plus the nearest-month future go into mbm_chain_snapshots. Uses ONLY the owner's
 * own Angel session through UserFeedManager (MBM_FEED_USER_ID, like the bar refresher): it never logs in.
 * Per instrument per tick: ⌈(2 + legs)/50⌉ batched FULL quotes + one optionGreek per expiry (+ one 1m index
 * candle window when the bar refresher has no fresh bar), spaced CALL_GAP_MS apart.
 *
 * Every way a due tick can store nothing is a counted, logged {@link SkipReason} (rate-limited per reason):
 * a throttled quote batch is retried twice (3 s, 6 s) before the tick gives up; a broker call (incl. the
 * session's re-login wait) is capped at CALL_TIMEOUT_MS; an overlapping tick is logged, and a stuck one is
 * overtaken after TICK_STALE_MS. A failed greek call only blanks IV/Greeks. The index tick holds the
 * {@link MbmCaptureLane}, so the per-symbol capture waits for it. 15:40 IST: one summary line per
 * instrument with ticks stored vs SESSION_TICKS and the reason counts. Never throws.
 */
@Injectable()
export class MbmChainCaptureService {
  private readonly logger = new Logger(MbmChainCaptureService.name);
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timer: (ms: number) => Promise<void>;
  private readonly limiter: WarnLimiter;
  private running = false;
  private runningSince = 0;
  private phase = 'idle';
  private generation = 0;
  private readonly contractCache = new Map<string, { day: string; value: CaptureContract[] }>();
  private readonly baselineCache = new Map<string, { day: string; value: Map<string, number> }>();
  private readonly futCache = new Map<string, { day: string; token: string | null }>();
  /** Per `${day}|${instrument}` ('*' = the whole tick): ok/failed ticks and skip reasons. */
  private readonly tally = new Map<string, DayTally>();

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_CALENDAR) private readonly calendar: NseCalendar,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly repo: MbmChainRepository,
    @Optional() @Inject(MBM_CHAIN_SLEEP) sleep?: (ms: number) => Promise<void>,
    @Optional() private readonly lane?: MbmCaptureLane,
    @Optional() @Inject(MBM_CHAIN_TIMER) timer?: (ms: number) => Promise<void>,
  ) {
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timer =
      timer ??
      ((ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms);
          t.unref?.();
        }));
    this.limiter = new WarnLimiter(SKIP_LOG_WINDOW_MS, () => this.now().getTime());
  }

  private get active(): boolean {
    return this.config.chainCapture === 'on' && !!this.config.feedUserId;
  }

  private get instruments(): string[] {
    return this.config.chainCaptureInstruments?.length ? this.config.chainCaptureInstruments : ['NIFTY'];
  }

  @Cron('40 */5 9-15 * * 1-5', { name: 'mbm-chain-capture', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<CaptureSummary> {
    if (!this.active) return idle;
    const now = this.now();
    if (!isChainCaptureTick(this.calendar, now)) return idle;
    const day = istYmd(now);
    if (this.running) {
      const age = now.getTime() - this.runningSince;
      if (age < TICK_STALE_MS) {
        this.skip(day, '*', 'overlap', `previous tick still running (${Math.round(age / 1000)} s, in ${this.phase})`);
        return { ...idle, reason: 'overlap' };
      }
      this.skip(day, '*', 'stuck', `previous tick stuck ${Math.round(age / 1000)} s in ${this.phase}: starting this one anyway`);
    }
    const gen = ++this.generation;
    this.running = true;
    this.runningSince = now.getTime();
    this.lane?.enterIndex();
    const counter = { calls: 0 };
    let stored = 0;
    const errors: string[] = [];
    try {
      const list = this.instruments;
      for (let i = 0; i < list.length; i++) {
        const instrument = list[i];
        const t = this.tallyFor(day, instrument);
        try {
          stored += await this.capture(instrument, counter, day);
          t.ok++;
        } catch (e) {
          t.failed++;
          t.lastError = errText(e);
          errors.push(errText(e));
          this.skip(day, instrument, reasonOf(e), errText(e));
          if (endsTick(e)) {
            // The broker said slow down (after the retries) or stopped answering: leave the rest of this tick.
            for (const rest of list.slice(i + 1)) {
              this.tallyFor(day, rest).failed++;
              this.skip(day, rest, 'not-tried', `not tried this tick (${reasonOf(e)} on ${instrument})`);
            }
            break;
          }
        }
      }
      const out: CaptureSummary = { ran: true, stored, calls: counter.calls };
      if (errors.length) out.error = errors.join('; ');
      return out;
    } finally {
      this.lane?.leaveIndex();
      if (this.generation === gen) {
        this.running = false;
        this.phase = 'idle';
      }
    }
  }

  /**
   * After the close: one line per captured instrument, `ticks/SESSION_TICKS` read from the table (what the
   * models will see), the in-process ok/failed tally and every skip reason counted today. A short day is a
   * WARN, so a dead or thinning capture is loud.
   */
  @Cron('0 40 15 * * 1-5', { name: 'mbm-chain-capture-summary', timeZone: 'Asia/Kolkata' })
  async daySummary(): Promise<string[]> {
    if (!this.active) return [];
    const now = this.now();
    if (!this.calendar.isTradingDay('NSE', now)) return [];
    const day = istYmd(now);
    try {
      const from = istMidnight(day);
      const counts = new Map((await this.repo.captureCounts(from, new Date(from.getTime() + DAY_MS))).map((c) => [c.instrument, c] as const));
      const whole = reasonText(this.tally.get(`${day}|*`));
      const lines: string[] = [];
      for (const instrument of this.instruments) {
        const c = counts.get(instrument);
        const t = this.tally.get(`${day}|${instrument}`);
        const ticks = c?.ticks ?? 0;
        const reasons = [reasonText(t), whole].filter(Boolean).join(', ');
        const line =
          `[mbm] chain capture ${day} ${instrument}: ${ticks}/${SESSION_TICKS} ticks, ${c?.rows ?? 0} rows stored` +
          ` (this process: ${t?.ok ?? 0} ok, ${t?.failed ?? 0} failed${reasons ? `; skips: ${reasons}` : ''}` +
          `${t?.lastError ? `; last error: ${t.lastError}` : ''})`;
        if (ticks < SESSION_TICKS * DAY_OK_SHARE) this.logger.warn(line);
        else this.logger.log(line);
        lines.push(line);
      }
      return lines;
    } catch (e) {
      this.logger.warn(`[mbm] chain capture ${day} summary unavailable: ${errText(e)}`);
      return [];
    }
  }

  /** Today's skip counts for `instrument` ('*' = whole-tick skips). For tests and the summary. */
  skipCounts(day: string, instrument: string): Record<string, number> {
    return Object.fromEntries(this.tally.get(`${day}|${instrument}`)?.reasons ?? []);
  }

  private tallyFor(day: string, instrument: string): DayTally {
    const key = `${day}|${instrument}`;
    let t = this.tally.get(key);
    if (!t) {
      if (this.tally.size > 60) this.tally.clear();
      t = { ok: 0, failed: 0, reasons: new Map() };
      this.tally.set(key, t);
    }
    return t;
  }

  /** Count a skip reason and log it (once per instrument × reason per SKIP_LOG_WINDOW_MS, with the repeats noted). */
  private skip(day: string, instrument: string, reason: SkipReason, detail: string): void {
    const r = this.tallyFor(day, instrument).reasons;
    r.set(reason, (r.get(reason) ?? 0) + 1);
    const who = instrument === '*' ? 'tick' : instrument;
    this.limiter.warn(this.logger, `${instrument}|${reason}`, `[mbm] chain capture ${who} skipped [${reason}]: ${detail}`);
  }

  private async capture(instrument: string, counter: { calls: number }, day: string): Promise<number> {
    const user = this.config.feedUserId as string;
    const startedAt = this.now();
    const index = INDEX_UNDERLYINGS[instrument];
    if (!index) throw new Error(`${instrument} is not an index underlying`);
    this.phase = `${instrument} master`;
    const expiries = (await this.repo.expiries(instrument, day)).slice(0, CHAIN_EXPIRIES);
    if (expiries.length === 0) throw new SkipError('no-expiries', `no ${instrument} option expiries in the instrument master`);

    const indexRef: TokenRef = { token: index.token, exchange: index.exchange };
    const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
      if (counter.calls > 0) await this.sleep(CALL_GAP_MS);
      counter.calls++;
      this.phase = `${instrument} ${what}`;
      const timeout = this.timer(CALL_TIMEOUT_MS).then((): never => {
        throw new CaptureTimeoutError(`${instrument} ${what}: no answer from the broker session in ${CALL_TIMEOUT_MS / 1000} s`);
      });
      timeout.catch(() => undefined); // settles after the race when the call won; never unhandled
      return Promise.race([fn(), timeout]);
    };
    /** Quote batch with the throttle retry: 3 s, then 6 s; a third throttle ends the tick. */
    const quoteBatch = async (n: number, chunk: TokenRef[]): Promise<Map<string, TickData>> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call(`quote batch ${n}`, () => this.feeds.fetchQuotes(user, chunk, { throwOnThrottle: true }));
        } catch (e) {
          if (!(e instanceof AngelThrottleError) || attempt >= THROTTLE_RETRIES) throw e;
          this.logger.debug(`[mbm] ${instrument} quote batch ${n} throttled, retry ${attempt + 1} in ${THROTTLE_RETRY_MS * (attempt + 1)} ms`);
          await this.sleep(THROTTLE_RETRY_MS * (attempt + 1));
        }
      }
    };

    // Centre of the strike window: the bar refresher's stored 1m close when fresh, else ONE 1m candle
    // window for the index (Angel declines index tokens in marketData for many API keys; history works).
    const since = new Date(startedAt.getTime() - SPOT_FRESH_MS);
    this.phase = `${instrument} centre`;
    let centre = await this.repo.latestClose(instrument, since);
    if (centre === null) {
      const candles = await call('index candle', () => this.feeds.fetchCandleWindow(user, indexRef, 'ONE_MINUTE', since, startedAt));
      const last = [...(candles ?? [])].reverse().find((c) => Number.isFinite(c.close) && c.close > 0);
      centre = last ? last.close : null;
    }
    if (centre === null) throw new SkipError('no-spot', `no ${instrument} spot (no fresh stored 1m bar, no index candle)`);

    const picked = new Map<string, CaptureContract[]>();
    for (const expiry of expiries) {
      const all = await this.contractsFor(instrument, expiry, day);
      const keep = new Set(strikesAround(all.map((c) => c.strike), centre, CHAIN_STRIKES_AROUND));
      picked.set(expiry, all.filter((c) => keep.has(c.strike)));
    }

    // The future rides in the same quote batches (one more token, not one more call): basis = fut − spot.
    const futToken = await this.futureFor(instrument, day);
    const refs: TokenRef[] = [indexRef];
    if (futToken) refs.push({ token: futToken, exchange: 'NFO' });
    for (const cs of picked.values()) for (const c of cs) refs.push({ token: c.token, exchange: 'NFO' });
    const quotes = new Map<string, TickData>();
    for (let i = 0; i < refs.length; i += QUOTE_BATCH_MAX) {
      const got = await quoteBatch(i / QUOTE_BATCH_MAX + 1, refs.slice(i, i + QUOTE_BATCH_MAX));
      for (const [k, v] of got ?? []) quotes.set(k, v);
    }
    const capturedAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const idx = quotes.get(indexRef.token);
    const spot = idx && idx.ltp > 0 ? idx.ltp : centre;
    const futQuote = futToken ? quotes.get(futToken) : undefined;
    const fut = futQuote && futQuote.ltp > 0 ? futQuote.ltp : null;

    const rows: ChainSnapshotRow[] = [];
    for (const expiry of expiries) {
      const contracts = picked.get(expiry) ?? [];
      if (!contracts.some((c) => quotes.has(c.token))) {
        this.skip(day, instrument, 'no-legs', `${expiry}: ${contracts.length} legs asked, none quoted (${quotes.size} tokens came back)`);
        continue;
      }
      let greeks: OptionGreekRow[] | null = null;
      try {
        greeks = await call(`greeks ${expiry}`, () => this.feeds.fetchOptionGreeks(user, instrument, expiry));
      } catch (e) {
        this.limiter.warn(this.logger, `${instrument}|greeks`, `[mbm] ${instrument} ${expiry} greeks unavailable (IV/Greeks stored null): ${errText(e)}`);
      }
      const snap = buildChainSnapshot({
        instrument,
        expiry,
        capturedAt,
        spot,
        contracts,
        quotes,
        greeks,
        baseline: await this.baselineFor(instrument, expiry, day, startedAt),
      });
      rows.push({ ...snap, fut });
    }
    if (rows.length === 0) throw new SkipError('no-legs', `${instrument}: no expiry had a quoted leg`);
    this.phase = `${instrument} insert`;
    const stored = await this.repo.insert(rows);
    if (stored < rows.length) this.skip(day, instrument, 'duplicate', `${rows.length - stored} of ${rows.length} rows already stored for ${capturedAt.toISOString()}`);
    return stored;
  }

  private async contractsFor(instrument: string, expiry: string, day: string): Promise<CaptureContract[]> {
    const key = `${instrument}|${expiry}`;
    const hit = this.contractCache.get(key);
    if (hit?.day === day && hit.value.length > 0) return hit.value;
    const value = await this.repo.contracts(instrument, expiry);
    if (this.contractCache.size > 20) this.contractCache.clear();
    this.contractCache.set(key, { day, value });
    return value;
  }

  /** Nearest-month future token, looked up once per instrument per day; a failed lookup → fut null this tick. */
  private async futureFor(instrument: string, day: string): Promise<string | null> {
    const hit = this.futCache.get(instrument);
    if (hit?.day === day && hit.token) return hit.token;
    try {
      const token = await this.repo.nearestFutureToken(instrument, day);
      this.futCache.set(instrument, { day, token });
      return token;
    } catch (e) {
      this.logger.debug(`[mbm] ${instrument} future lookup failed (fut stored null): ${errText(e)}`);
      return null;
    }
  }

  /** OI of the expiry's last snapshot before today's IST midnight, read once per day; failure → no oi_chg. */
  private async baselineFor(instrument: string, expiry: string, day: string, at: Date): Promise<Map<string, number> | null> {
    const key = `${instrument}|${expiry}`;
    const hit = this.baselineCache.get(key);
    if (hit?.day === day) return hit.value;
    try {
      const value = baselineFrom(await this.repo.strikesBefore(instrument, expiry, istMidnight(istYmd(at))));
      if (this.baselineCache.size > 20) this.baselineCache.clear();
      this.baselineCache.set(key, { day, value });
      return value;
    } catch (e) {
      this.logger.debug(`[mbm] ${instrument} ${expiry} OI baseline unavailable: ${errText(e)}`);
      return null;
    }
  }
}

/** A known, non-broker reason an instrument stored nothing this tick. */
class SkipError extends Error {
  constructor(
    readonly reason: SkipReason,
    message: string,
  ) {
    super(message);
  }
}

function reasonOf(e: unknown): SkipReason {
  if (e instanceof SkipError) return e.reason;
  if (e instanceof AngelThrottleError) return 'throttled';
  if (e instanceof CaptureTimeoutError) return 'timeout';
  return 'error';
}

function reasonText(t: DayTally | undefined): string {
  return t ? [...t.reasons].map(([r, n]) => `${r} ${n}`).join(', ') : '';
}
