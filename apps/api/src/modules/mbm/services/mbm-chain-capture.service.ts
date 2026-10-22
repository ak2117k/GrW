// apps/api/src/modules/mbm/services/mbm-chain-capture.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
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

/** Test seam for the gap between broker calls. */
export const MBM_CHAIN_SLEEP = Symbol('MBM_CHAIN_SLEEP');

/** Angel marketData FULL takes at most 50 tokens per call (the hub's QuoteBatcher uses the same cap). */
export const QUOTE_BATCH_MAX = 50;
/** Gap between this tick's broker calls: ≤ ~3/s, far under Angel's 10 req/s quote limit. */
export const CALL_GAP_MS = 350;
/** An index 1m close younger than this centres the strike window (stored: no broker call). */
export const SPOT_FRESH_MS = 10 * 60_000;
/** A day with fewer distinct ticks than this share of SESSION_TICKS logs its summary as a warning. */
export const DAY_OK_SHARE = 0.9;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);

export interface CaptureSummary {
  ran: boolean;
  stored: number;
  /** Broker calls this tick made (quote batches + greek calls + any index candle window). */
  calls: number;
  /** Per-instrument failure messages joined with '; ' (one failing instrument: just its message). */
  error?: string;
}

const idle: CaptureSummary = { ran: false, stored: 0, calls: 0 };

/**
 * Index option-chain capture (MBM_CHAIN_CAPTURE=on; MBM_CHAIN_CAPTURE_INSTRUMENTS, default NIFTY,BANKNIFTY):
 * every 5 min at second 40, 09:15–15:30 IST on NSE trading days, per instrument the nearest two expiries ×
 * ATM ±15 strikes × CE/PE plus the nearest-month future go into mbm_chain_snapshots. Uses ONLY the owner's
 * own Angel session through UserFeedManager (MBM_FEED_USER_ID, like the bar refresher): it never logs in.
 * Per instrument per tick: ⌈(2 + legs)/50⌉ batched FULL quotes + one optionGreek per expiry (+ one 1m index
 * candle window when the bar refresher has no fresh bar), spaced CALL_GAP_MS apart. A failed quote batch
 * skips that instrument's tick (a partial chain would skew PCR / max pain); a throttle skips the rest of the
 * tick; a failed greek call only blanks IV/Greeks. 15:40 IST: one summary line per instrument (ticks stored
 * vs SESSION_TICKS, WARN when short). Never throws.
 */
@Injectable()
export class MbmChainCaptureService {
  private readonly logger = new Logger(MbmChainCaptureService.name);
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private readonly contractCache = new Map<string, { day: string; value: CaptureContract[] }>();
  private readonly baselineCache = new Map<string, { day: string; value: Map<string, number> }>();
  private readonly futCache = new Map<string, { day: string; token: string | null }>();
  /** In-process tick outcomes per `${day}|${instrument}` (the summary's second opinion beside the DB count). */
  private readonly tally = new Map<string, { ok: number; failed: number; lastError?: string }>();

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_CALENDAR) private readonly calendar: NseCalendar,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly repo: MbmChainRepository,
    @Optional() @Inject(MBM_CHAIN_SLEEP) sleep?: (ms: number) => Promise<void>,
  ) {
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    if (!isChainCaptureTick(this.calendar, this.now())) return idle;
    if (this.running) return idle; // the previous tick is still pacing through
    this.running = true;
    const counter = { calls: 0 };
    let stored = 0;
    const errors: string[] = [];
    try {
      for (const instrument of this.instruments) {
        const t = this.tallyFor(istYmd(this.now()), instrument);
        try {
          stored += await this.capture(instrument, counter);
          t.ok++;
        } catch (e) {
          t.failed++;
          t.lastError = errText(e);
          errors.push(errText(e));
          this.logger.warn(`[mbm] ${instrument} chain capture skipped: ${errText(e)}`);
          if (e instanceof AngelThrottleError) break; // the broker said slow down: leave the rest of this tick
        }
      }
      const out: CaptureSummary = { ran: true, stored, calls: counter.calls };
      if (errors.length) out.error = errors.join('; ');
      return out;
    } finally {
      this.running = false;
    }
  }

  /**
   * After the close: one line per captured instrument, `ticks/SESSION_TICKS` read from the table (what the
   * models will see) and the in-process ok/failed tally. A short day is a WARN, so a dead capture is loud.
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
      const lines: string[] = [];
      for (const instrument of this.instruments) {
        const c = counts.get(instrument);
        const t = this.tally.get(`${day}|${instrument}`);
        const ticks = c?.ticks ?? 0;
        const line =
          `[mbm] chain capture ${day} ${instrument}: ${ticks}/${SESSION_TICKS} ticks, ${c?.rows ?? 0} rows stored` +
          ` (this process: ${t?.ok ?? 0} ok, ${t?.failed ?? 0} failed${t?.lastError ? `, last error: ${t.lastError}` : ''})`;
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

  private tallyFor(day: string, instrument: string): { ok: number; failed: number; lastError?: string } {
    const key = `${day}|${instrument}`;
    let t = this.tally.get(key);
    if (!t) {
      if (this.tally.size > 40) this.tally.clear();
      t = { ok: 0, failed: 0 };
      this.tally.set(key, t);
    }
    return t;
  }

  private async capture(instrument: string, counter: { calls: number }): Promise<number> {
    const user = this.config.feedUserId as string;
    const startedAt = this.now();
    const day = istYmd(startedAt);
    const index = INDEX_UNDERLYINGS[instrument];
    if (!index) throw new Error(`${instrument} is not an index underlying`);
    const expiries = (await this.repo.expiries(instrument, day)).slice(0, CHAIN_EXPIRIES);
    if (expiries.length === 0) throw new Error(`no ${instrument} option expiries in the instrument master`);

    const indexRef: TokenRef = { token: index.token, exchange: index.exchange };
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (counter.calls > 0) await this.sleep(CALL_GAP_MS);
      counter.calls++;
      return fn();
    };

    // Centre of the strike window: the bar refresher's stored 1m close when fresh, else ONE 1m candle
    // window for the index (Angel declines index tokens in marketData for many API keys; history works).
    const since = new Date(startedAt.getTime() - SPOT_FRESH_MS);
    let centre = await this.repo.latestClose(instrument, since);
    if (centre === null) {
      const candles = await call(() => this.feeds.fetchCandleWindow(user, indexRef, 'ONE_MINUTE', since, startedAt));
      const last = [...(candles ?? [])].reverse().find((c) => Number.isFinite(c.close) && c.close > 0);
      centre = last ? last.close : null;
    }
    if (centre === null) throw new Error(`no ${instrument} spot (no fresh stored 1m bar, no index candle)`);

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
      const chunk = refs.slice(i, i + QUOTE_BATCH_MAX);
      const got = await call(() => this.feeds.fetchQuotes(user, chunk, { throwOnThrottle: true }));
      for (const [k, v] of got) quotes.set(k, v);
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
        this.logger.warn(`[mbm] ${instrument} ${expiry}: no leg quoted — expiry skipped this tick`);
        continue;
      }
      let greeks: OptionGreekRow[] | null = null;
      try {
        greeks = await call(() => this.feeds.fetchOptionGreeks(user, instrument, expiry));
      } catch (e) {
        this.logger.warn(`[mbm] ${instrument} ${expiry} greeks unavailable (IV/Greeks stored null): ${errText(e)}`);
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
    return this.repo.insert(rows);
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
