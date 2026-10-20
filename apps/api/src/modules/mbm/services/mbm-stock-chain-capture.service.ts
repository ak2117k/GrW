// apps/api/src/modules/mbm/services/mbm-stock-chain-capture.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import type { OptionGreekRow } from '../../market-hub/chain/chain.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { CHAIN_WATCHLIST, type ChainWatchlist } from '../chain-watchlist';
import type { NseCalendar } from '../domain/bar-window';
import { baselineFrom, buildChainSnapshot, istYmd, strikesAround, type CaptureContract, type ChainSnapshotRow } from '../domain/chain-snapshot';
import { STOCK_STRIKES_AROUND, packBatches, stockChainTick, type StockTick } from '../domain/stock-chain';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';
import { MbmChainRepository } from '../repositories/mbm-chain.repository';
import { MBM_CALENDAR, MBM_NOW } from './mbm-bar-refresher.service';
import { CALL_GAP_MS, MBM_CHAIN_SLEEP, QUOTE_BATCH_MAX } from './mbm-chain-capture.service';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface StockCaptureSummary {
  ran: boolean;
  tick: StockTick;
  stored: number;
  /** Broker calls this tick made (spot batches + index candle fallbacks + leg batches + greek calls). */
  calls: number;
  /** Symbols captured this tick. */
  captured: string[];
  /** Symbols skipped this tick (unresolvable chain, no spot, failed quote batch, nothing quoted). */
  skipped: string[];
  error?: string;
}

interface Resolved {
  name: string;
  expiry: string;
  ref: TokenRef;
  isIndex: boolean;
  contracts: CaptureContract[];
}

/**
 * Per-symbol option-chain capture (MBM_CHAIN_CAPTURE_STOCKS=on) for the {@link ChainWatchlist}: the
 * underlyings of the owner's open NFO positions + symbols the news scan registered. Every 15 min
 * 09:15–15:15 IST plus the 15:30 EOD snapshot, nearest expiry × ATM ±10 × CE/PE, into
 * mbm_chain_snapshots (`instrument` = underlying name). Same owner-session path as the NIFTY capture
 * (UserFeedManager, MBM_FEED_USER_ID) — it never logs in.
 *
 * Calls per tick for N symbols: ⌈N/50⌉ spot quotes (+1 candle per non-NIFTY index whose quote has no
 * LTP) + ⌈legs/50⌉ leg quotes packed across symbols (≤42 legs each) + N greek calls, CALL_GAP_MS apart.
 * Failure isolation: a symbol that cannot be resolved is skipped (logged once per day); a failed quote
 * batch blanks only the symbols it carried (a throttle stops further quote calls this tick); a failed
 * greek call only blanks IV/Greeks. Never throws.
 */
@Injectable()
export class MbmStockChainCaptureService {
  private readonly logger = new Logger(MbmStockChainCaptureService.name);
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private readonly resolveCache = new Map<string, { day: string; value: Resolved }>();
  private readonly baselineCache = new Map<string, { day: string; value: Map<string, number> | null }>();
  private readonly loggedSkips = new Set<string>();
  private loggedSkipsDay = '';

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_CALENDAR) private readonly calendar: NseCalendar,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly repo: MbmChainRepository,
    @Inject(CHAIN_WATCHLIST) private readonly watchlist: ChainWatchlist,
    @Optional() @Inject(MBM_CHAIN_SLEEP) sleep?: (ms: number) => Promise<void>,
  ) {
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get active(): boolean {
    return this.config.chainCaptureStocks === 'on' && !!this.config.feedUserId;
  }

  /** Second 55: clear of the NIFTY capture's second-40 tick so the two never pace through Angel together. */
  @Cron('55 */15 9-15 * * 1-5', { name: 'mbm-stock-chain-capture', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<StockCaptureSummary> {
    const idle = (tick: StockTick): StockCaptureSummary => ({ ran: false, tick, stored: 0, calls: 0, captured: [], skipped: [] });
    if (!this.active) return idle('NONE');
    const tick = stockChainTick(this.calendar, this.now());
    if (tick === 'NONE') return idle(tick);
    if (this.running) return idle(tick);
    this.running = true;
    const counter = { calls: 0 };
    const skipped = new Set<string>();
    try {
      const { stored, captured } = await this.capture(counter, skipped);
      return { ran: true, tick, stored, calls: counter.calls, captured, skipped: [...skipped] };
    } catch (e) {
      this.logger.warn(`[mbm] per-symbol chain capture skipped: ${errText(e)}`);
      return { ran: true, tick, stored: 0, calls: counter.calls, captured: [], skipped: [...skipped], error: errText(e) };
    } finally {
      this.running = false;
    }
  }

  private skipOnce(day: string, name: string, why: string, skipped: Set<string>): void {
    skipped.add(name);
    if (this.loggedSkipsDay !== day) {
      this.loggedSkips.clear();
      this.loggedSkipsDay = day;
    }
    if (this.loggedSkips.has(name)) return;
    this.loggedSkips.add(name);
    this.logger.warn(`[mbm] chain ${name} skipped (${why}) — logged once today`);
  }

  private async capture(counter: { calls: number }, skipped: Set<string>): Promise<{ stored: number; captured: string[] }> {
    const user = this.config.feedUserId as string;
    const startedAt = this.now();
    const day = istYmd(startedAt);
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (counter.calls > 0) await this.sleep(CALL_GAP_MS);
      counter.calls++;
      return fn();
    };

    // 1. Resolve every symbol from the DB (no broker calls): nearest expiry, its contracts, the spot ref.
    const resolved: Resolved[] = [];
    for (const { symbol } of await this.watchlist.symbols()) {
      try {
        const r = await this.resolve(symbol, day);
        if (typeof r === 'string') this.skipOnce(day, symbol, r, skipped);
        else resolved.push(r);
      } catch (e) {
        this.skipOnce(day, symbol, `resolve failed: ${errText(e)}`, skipped);
      }
    }
    if (resolved.length === 0) return { stored: 0, captured: [] };

    // 2. Spots: one batched quote for every underlying (≤50 per call).
    let throttled = false;
    const spotQuotes = new Map<string, TickData>();
    for (const batch of packBatches(resolved.map((r) => ({ key: r.name, items: [r.ref] })), QUOTE_BATCH_MAX)) {
      try {
        const got = await call(() => this.feeds.fetchQuotes(user, batch.items, { throwOnThrottle: true }));
        for (const [k, v] of got) spotQuotes.set(k, v);
      } catch (e) {
        if (e instanceof AngelThrottleError) throttled = true;
        this.logger.warn(`[mbm] chain spot batch failed (${[...batch.keys].join(',')}): ${errText(e)}`);
        if (throttled) break;
      }
    }
    if (throttled) {
      for (const r of resolved) skipped.add(r.name);
      return { stored: 0, captured: [] };
    }

    const spots = new Map<string, number>();
    for (const r of resolved) {
      const q = spotQuotes.get(r.ref.token);
      if (q && q.ltp > 0) {
        spots.set(r.name, q.ltp);
        continue;
      }
      if (r.isIndex) {
        // Angel declines index tokens in marketData for many API keys; one 1m candle window instead.
        try {
          const since = new Date(startedAt.getTime() - 10 * 60_000);
          const candles = await call(() => this.feeds.fetchCandleWindow(user, r.ref, 'ONE_MINUTE', since, startedAt));
          const last = [...(candles ?? [])].reverse().find((c) => Number.isFinite(c.close) && c.close > 0);
          if (last) {
            spots.set(r.name, last.close);
            continue;
          }
        } catch (e) {
          this.logger.debug(`[mbm] ${r.name} index candle failed: ${errText(e)}`);
        }
      }
      this.skipOnce(day, r.name, 'no spot quote', skipped);
    }

    // 3. Legs: ATM ±10 of the nearest expiry, packed across symbols into ≤50-token batches.
    const legsBy = new Map<string, CaptureContract[]>();
    for (const r of resolved) {
      const spot = spots.get(r.name);
      if (spot === undefined) continue;
      const keep = new Set(strikesAround(r.contracts.map((c) => c.strike), spot, STOCK_STRIKES_AROUND));
      legsBy.set(r.name, r.contracts.filter((c) => keep.has(c.strike)));
    }
    const legQuotes = new Map<string, TickData>();
    const failed = new Set<string>();
    const batches = packBatches(
      [...legsBy].map(([key, cs]) => ({ key, items: cs.map((c): TokenRef => ({ token: c.token, exchange: 'NFO' })) })),
      QUOTE_BATCH_MAX,
    );
    for (const batch of batches) {
      if (throttled) {
        for (const k of batch.keys) failed.add(k);
        continue;
      }
      try {
        const got = await call(() => this.feeds.fetchQuotes(user, batch.items, { throwOnThrottle: true }));
        for (const [k, v] of got) legQuotes.set(k, v);
      } catch (e) {
        if (e instanceof AngelThrottleError) throttled = true;
        for (const k of batch.keys) failed.add(k);
        this.logger.warn(`[mbm] chain leg batch failed (${[...batch.keys].join(',')}): ${errText(e)}`);
      }
    }

    // 4. Per symbol: greeks (failure → IV/Greeks null) and the snapshot row.
    const capturedAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const rows: ChainSnapshotRow[] = [];
    for (const r of resolved) {
      const contracts = legsBy.get(r.name);
      if (!contracts) continue;
      if (failed.has(r.name)) {
        skipped.add(r.name); // a partial chain would skew PCR / max pain
        continue;
      }
      if (!contracts.some((c) => legQuotes.has(c.token))) {
        this.skipOnce(day, r.name, `no leg quoted for ${r.expiry}`, skipped);
        continue;
      }
      let greeks: OptionGreekRow[] | null = null;
      if (!throttled) {
        try {
          greeks = await call(() => this.feeds.fetchOptionGreeks(user, r.name, r.expiry));
        } catch (e) {
          this.logger.debug(`[mbm] ${r.name} ${r.expiry} greeks unavailable (IV/Greeks stored null): ${errText(e)}`);
        }
      }
      rows.push(
        buildChainSnapshot({
          instrument: r.name,
          expiry: r.expiry,
          capturedAt,
          spot: spots.get(r.name) as number,
          contracts,
          quotes: legQuotes,
          greeks,
          baseline: await this.baselineFor(r.name, r.expiry, day, startedAt),
        }),
      );
    }
    const stored = await this.repo.insert(rows);
    return { stored, captured: rows.map((x) => x.instrument) };
  }

  /** The symbol's nearest expiry, its contracts and spot ref (cached per IST day; failures are never cached). */
  private async resolve(name: string, day: string): Promise<Resolved | string> {
    const hit = this.resolveCache.get(name);
    if (hit?.day === day) return hit.value;
    const expiry = (await this.repo.expiries(name, day))[0];
    if (!expiry) return 'no option expiry in the instrument master';
    const contracts = await this.repo.contracts(name, expiry);
    if (contracts.length === 0) return `no NFO contracts for ${expiry}`;
    const ref = await this.repo.underlyingRef(name, expiry);
    if (!ref) return 'no underlying (index/NSE cash) instrument';
    const value: Resolved = { name, expiry, contracts, ref: { token: ref.token, exchange: ref.exchange }, isIndex: !!INDEX_UNDERLYINGS[name] };
    if (this.resolveCache.size > 200) this.resolveCache.clear();
    this.resolveCache.set(name, { day, value });
    return value;
  }

  /** OI of the expiry's last snapshot before today's IST midnight, read once per day; failure → no oi_chg. */
  private async baselineFor(name: string, expiry: string, day: string, at: Date): Promise<Map<string, number> | null> {
    const key = `${name}:${expiry}`;
    const hit = this.baselineCache.get(key);
    if (hit?.day === day) return hit.value;
    try {
      const midnight = new Date(Date.parse(`${istYmd(at)}T00:00:00Z`) - IST_OFFSET_MS);
      const value = baselineFrom(await this.repo.strikesBefore(name, expiry, midnight));
      if (this.baselineCache.size > 200) this.baselineCache.clear();
      this.baselineCache.set(key, { day, value });
      return value;
    } catch (e) {
      this.logger.debug(`[mbm] ${name} ${expiry} OI baseline unavailable: ${errText(e)}`);
      return null;
    }
  }
}
