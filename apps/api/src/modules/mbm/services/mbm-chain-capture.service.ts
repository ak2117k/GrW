// apps/api/src/modules/mbm/services/mbm-chain-capture.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import type { OptionGreekRow } from '../../market-hub/chain/chain.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import type { NseCalendar } from '../domain/bar-window';
import {
  CHAIN_EXPIRIES,
  CHAIN_STRIKES_AROUND,
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

export const CAPTURE_INSTRUMENT = 'NIFTY';
/** Angel marketData FULL takes at most 50 tokens per call (the hub's QuoteBatcher uses the same cap). */
export const QUOTE_BATCH_MAX = 50;
/** Gap between this tick's broker calls: ≤ ~3/s, far under Angel's 10 req/s quote limit. */
export const CALL_GAP_MS = 350;
/** A NIFTY 1m close younger than this centres the strike window (stored: no broker call). */
export const SPOT_FRESH_MS = 10 * 60_000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CaptureSummary {
  ran: boolean;
  stored: number;
  /** Broker calls this tick made (quote batches + greek calls). */
  calls: number;
  error?: string;
}

const idle: CaptureSummary = { ran: false, stored: 0, calls: 0 };

/**
 * NIFTY option-chain capture (MBM_CHAIN_CAPTURE=on): every 5 min at second 40, 09:15–15:30 IST on NSE
 * trading days, the nearest two expiries × ATM ±15 strikes × CE/PE go into mbm_chain_snapshots. Uses
 * ONLY the owner's own Angel session through UserFeedManager (MBM_FEED_USER_ID, like the bar refresher):
 * it never logs in itself. Per tick: ⌈(1 + legs)/50⌉ batched FULL quotes + one optionGreek per expiry
 * (+ one 1m index candle window when the bar refresher has no fresh NIFTY bar),
 * spaced CALL_GAP_MS apart; a throttled or failed quote batch skips the whole tick (a partial chain would
 * skew PCR / max pain), a failed greek call only blanks IV/Greeks. Never throws.
 */
@Injectable()
export class MbmChainCaptureService {
  private readonly logger = new Logger(MbmChainCaptureService.name);
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private readonly contractCache = new Map<string, { day: string; value: CaptureContract[] }>();
  private readonly baselineCache = new Map<string, { day: string; value: Map<string, number> }>();

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

  @Cron('40 */5 9-15 * * 1-5', { name: 'mbm-chain-capture', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<CaptureSummary> {
    if (!this.active) return idle;
    if (!isChainCaptureTick(this.calendar, this.now())) return idle;
    if (this.running) return idle; // the previous tick is still pacing through
    this.running = true;
    const counter = { calls: 0 };
    try {
      const stored = await this.capture(counter);
      return { ran: true, stored, calls: counter.calls };
    } catch (e) {
      this.logger.warn(`[mbm] ${CAPTURE_INSTRUMENT} chain capture skipped: ${errText(e)}`);
      return { ran: true, stored: 0, calls: counter.calls, error: errText(e) };
    } finally {
      this.running = false;
    }
  }

  private async capture(counter: { calls: number }): Promise<number> {
    const user = this.config.feedUserId as string;
    const startedAt = this.now();
    const day = istYmd(startedAt);
    const expiries = (await this.repo.expiries(CAPTURE_INSTRUMENT, day)).slice(0, CHAIN_EXPIRIES);
    if (expiries.length === 0) throw new Error('no NIFTY option expiries in the instrument master');

    const index = INDEX_UNDERLYINGS[CAPTURE_INSTRUMENT];
    const indexRef: TokenRef = { token: index.token, exchange: index.exchange };
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (counter.calls > 0) await this.sleep(CALL_GAP_MS);
      counter.calls++;
      return fn();
    };

    // Centre of the strike window: the bar refresher's stored 1m close when fresh, else ONE 1m candle
    // window for the index (Angel declines index tokens in marketData for many API keys; history works).
    const since = new Date(startedAt.getTime() - SPOT_FRESH_MS);
    let centre = await this.repo.latestClose(CAPTURE_INSTRUMENT, since);
    if (centre === null) {
      const candles = await call(() => this.feeds.fetchCandleWindow(user, indexRef, 'ONE_MINUTE', since, startedAt));
      const last = [...(candles ?? [])].reverse().find((c) => Number.isFinite(c.close) && c.close > 0);
      centre = last ? last.close : null;
    }
    if (centre === null) throw new Error('no NIFTY spot (no fresh stored 1m bar, no index candle)');

    const picked = new Map<string, CaptureContract[]>();
    for (const expiry of expiries) {
      const all = await this.contractsFor(expiry, day);
      const keep = new Set(strikesAround(all.map((c) => c.strike), centre, CHAIN_STRIKES_AROUND));
      picked.set(expiry, all.filter((c) => keep.has(c.strike)));
    }

    const refs: TokenRef[] = [indexRef];
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

    const rows: ChainSnapshotRow[] = [];
    for (const expiry of expiries) {
      const contracts = picked.get(expiry) ?? [];
      if (!contracts.some((c) => quotes.has(c.token))) {
        this.logger.warn(`[mbm] ${CAPTURE_INSTRUMENT} ${expiry}: no leg quoted — expiry skipped this tick`);
        continue;
      }
      let greeks: OptionGreekRow[] | null = null;
      try {
        greeks = await call(() => this.feeds.fetchOptionGreeks(user, CAPTURE_INSTRUMENT, expiry));
      } catch (e) {
        this.logger.warn(`[mbm] ${CAPTURE_INSTRUMENT} ${expiry} greeks unavailable (IV/Greeks stored null): ${errText(e)}`);
      }
      rows.push(
        buildChainSnapshot({
          instrument: CAPTURE_INSTRUMENT,
          expiry,
          capturedAt,
          spot,
          contracts,
          quotes,
          greeks,
          baseline: await this.baselineFor(expiry, day, startedAt),
        }),
      );
    }
    return this.repo.insert(rows);
  }

  private async contractsFor(expiry: string, day: string): Promise<CaptureContract[]> {
    const hit = this.contractCache.get(expiry);
    if (hit?.day === day && hit.value.length > 0) return hit.value;
    const value = await this.repo.contracts(CAPTURE_INSTRUMENT, expiry);
    if (this.contractCache.size > 20) this.contractCache.clear();
    this.contractCache.set(expiry, { day, value });
    return value;
  }

  /** OI of the expiry's last snapshot before today's IST midnight, read once per day; failure → no oi_chg. */
  private async baselineFor(expiry: string, day: string, at: Date): Promise<Map<string, number> | null> {
    const hit = this.baselineCache.get(expiry);
    if (hit?.day === day) return hit.value;
    try {
      const midnight = new Date(Date.parse(`${istYmd(at)}T00:00:00Z`) - IST_OFFSET_MS);
      const value = baselineFrom(await this.repo.strikesBefore(CAPTURE_INSTRUMENT, expiry, midnight));
      if (this.baselineCache.size > 20) this.baselineCache.clear();
      this.baselineCache.set(expiry, { day, value });
      return value;
    } catch (e) {
      this.logger.debug(`[mbm] ${CAPTURE_INSTRUMENT} ${expiry} OI baseline unavailable: ${errText(e)}`);
      return null;
    }
  }
}
