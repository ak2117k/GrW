import { Inject, Injectable, Optional } from '@nestjs/common';
import { BreadthSectorService } from '../../market-data/services/breadth-sector.service';
import { MARKET_QUOTE_RESOLVER, type QuoteResolverLike } from '../../market-data/services/batch-quotes.service';
import { SignalContextService } from '../../signal-trader/services/signal-context.service';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import type { Vocabulary } from '../../signal-intake/domain/vocabulary';
import { SignalVocabularyService } from '../../signal-intake/services/signal-vocabulary.service';
import { infoRefOf, SIGNAL_INFO_BARS, SIGNAL_INFO_MASTER, type InfoBars } from '../../signal-intake/services/signal-outcome.service';
import { readerQuote, type Bar15m, type QuoteLtp } from '../domain/reader-quote';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { READER_PACKET_SOURCES, type ReaderPacketSources } from './reader-packet.sources';

export type PacketBlock = { status: 'present'; source: string; value: unknown } | { status: 'unavailable'; source: string; reason: string };

export interface ReaderPacket {
  at: string;
  marketPulse: { indices: PacketBlock; breadth: PacketBlock; sectors: PacketBlock };
  instruments: Record<string, Record<string, unknown>>;
  channelRecent: PacketBlock;
  todayNotes: PacketBlock;
}

type MarketPulse = ReaderPacket['marketPulse'];

/** The market pulse (indices, breadth, sectors) is shared by every post read within this window. */
const PULSE_CACHE_MS = 60_000;
/** A pulse / instrument result with an unavailable block is kept only this long, so a blip heals fast. */
const UNAVAILABLE_CACHE_MS = 10_000;
/** Default reader instrument builds in flight at once (MESSAGE_READER_MAX_INSTRUMENT_BUILDS). */
const DEFAULT_MAX_INSTRUMENT_BUILDS = 2;
const MAX_INSTRUMENTS = 3;
/** A named instrument's context is shared the same way (concurrent posts on one underlying build it once). */
const INSTRUMENT_CACHE_MS = 60_000;
/** The whole-instrument race sits this far past the per-block deadline, as a safety net only. */
const SAFETY_MARGIN_MS = 500;
const CHANNEL_WINDOW_MS = 30 * 60_000;
/** A named instrument's quote block is shared for this long (UNAVAILABLE_CACHE_MS when unavailable). */
const QUOTE_CACHE_MS = 60_000;
/** Daily bars fetched for the quote: 60 prior sessions + holidays. Kept per instrument for the IST session day. */
const QUOTE_DAILY_DAYS = 100;
/** 15m bars fetched for the quote: enough to reach the last 8 closed bars across a weekend / holiday. */
const QUOTE_15M_DAYS = 5;
const DAY_MS = 86_400_000;
const MAX_ROWS = 10;

/** Index quotes for the pulse (tokens as in market-context's UNDERLYING_TOKEN_MAP). */
const PULSE_INDICES = [
  { name: 'NIFTY', token: '99926000', exchange: 'NSE' },
  { name: 'BANKNIFTY', token: '99926009', exchange: 'NSE' },
  { name: 'SENSEX', token: '99919000', exchange: 'BSE' },
] as const;

const SRC = {
  indices: 'market-quote-resolver (NIFTY, BANKNIFTY, SENSEX)',
  breadth: 'breadth-sector (advance / decline)',
  sectors: 'breadth-sector (sector performance)',
  instrument: 'signal-context (judge market packet)',
  frontFuture: 'signal-context underlying quote (MCX front-month future)',
  channel: 'message_readings (this channel, last 30 min)',
  notes: 'message_readings (today, confirmed / contradicted market claims)',
  quote: 'market-quote-resolver + owner daily / 15m bars (index, NSE cash, MCX front future)',
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type CacheEntry<T> = { at: number; ttl: number; promise: Promise<T> };

const isUnavailable = (b: unknown) => !!b && typeof b === 'object' && (b as { status?: unknown }).status === 'unavailable';
/** True when any top-level block of a pulse / instrument result is unavailable. */
const hasUnavailable = (r: object) => Object.values(r).some(isUnavailable);

/**
 * Builds the data packet the AI reader checks a post against: market pulse, the instruments the post
 * names, the channel's recent posts and today's settled market notes. Every source runs in parallel and
 * is raced against MESSAGE_READER_PACKET_MS; a slow or failing source becomes an `unavailable` block,
 * never a throw. The pulse costs a quote batch on the owner's Angel session (10 req/s), so it is cached
 * for 60 s and concurrent builds share one in-flight fetch.
 */
@Injectable()
export class ReaderPacketService {
  private pulse: CacheEntry<MarketPulse> | null = null;
  private readonly instruments = new Map<string, CacheEntry<Record<string, unknown>>>();
  /** Reader instrument builds in flight across all posts (the owner's broker session is shared with the live judge). */
  private buildsInFlight = 0;
  private readonly buildWaiters: Array<() => void> = [];
  private readonly quoteCache = new Map<string, CacheEntry<PacketBlock>>();
  /** Daily bars per EXCHANGE:token for one IST session day (the previous-session stats do not move intraday). */
  private readonly dailyCache = new Map<string, { day: string; promise: Promise<DailyBar[]> }>();

  constructor(
    private readonly breadth: BreadthSectorService,
    @Inject(MARKET_QUOTE_RESOLVER) private readonly quotes: QuoteResolverLike,
    private readonly context: SignalContextService,
    @Inject(READER_PACKET_SOURCES) private readonly sources: ReaderPacketSources,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: SignalTraderConfig,
    @Optional() @Inject(SIGNAL_INFO_BARS) private readonly bars?: InfoBars,
    @Optional() @Inject(SIGNAL_INFO_MASTER) private readonly master?: { rows(): Promise<readonly unknown[] | null> },
    @Optional() @Inject(SignalVocabularyService) private readonly vocab?: { get(): Promise<Vocabulary> },
  ) {}

  async build(i: { text: string; channelId: string; underlyings: string[]; now: Date }): Promise<{ packet: ReaderPacket; ms: number }> {
    const started = Date.now();
    const names = [...new Set(i.underlyings.map((u) => u.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_INSTRUMENTS);
    const owner = this.traderCfg.ownerUserId;
    const [marketPulse, instruments, channelRecent, todayNotes] = await Promise.all([
      this.marketPulse(owner),
      Promise.all(
        names.map(async (u) => {
          const [ctx, quote] = await Promise.all([this.instrument(u, owner, i.now, started), this.quote(u, owner, i.now, started)]);
          return [u, { ...ctx, quote }] as const;
        }),
      ),
      this.block(SRC.channel, async () => (await this.sources.recentChannelPosts(i.channelId, new Date(i.now.getTime() - CHANNEL_WINDOW_MS))).slice(0, MAX_ROWS)),
      this.block(SRC.notes, async () => (await this.sources.todayMarketNotes(istYmd(i.now))).slice(0, MAX_ROWS)),
    ]);
    const packet: ReaderPacket = { at: i.now.toISOString(), marketPulse, instruments: Object.fromEntries(instruments), channelRecent, todayNotes };
    return { packet, ms: Date.now() - started };
  }

  private marketPulse(owner: string | null): Promise<MarketPulse> {
    const now = Date.now();
    if (this.pulse && now - this.pulse.at < this.pulse.ttl) return this.pulse.promise;
    const promise = this.fetchPulse(owner);
    const entry: CacheEntry<MarketPulse> = { at: now, ttl: PULSE_CACHE_MS, promise };
    this.pulse = entry;
    void promise.then((r) => {
      if (hasUnavailable(r)) entry.ttl = UNAVAILABLE_CACHE_MS;
    });
    return promise;
  }

  private async fetchPulse(owner: string | null): Promise<MarketPulse> {
    const need = <T>(f: (userId: string) => Promise<T>) => async () => {
      if (!owner) throw new Error('no owner user id (HUB_OWNER_USER_ID) to quote with');
      return f(owner);
    };
    const [indices, breadth, sectors] = await Promise.all([
      this.block(SRC.indices, need(async (u) => {
        const q = await this.quotes.resolveQuotes(u, PULSE_INDICES.map(({ token, exchange, name }) => ({ token, exchange, symbol: name })));
        const out: Record<string, unknown> = {};
        for (const ix of PULSE_INDICES) {
          const r = q.get(ix.token);
          if (r) out[ix.name] = { ltp: r.ltp, prevClose: r.close, change: r.change, changePercent: r.changePercent, at: new Date(r.timestamp).toISOString() };
        }
        if (Object.keys(out).length === 0) throw new Error('no index quote returned');
        return out;
      })),
      this.block(SRC.breadth, need((u) => this.breadth.getBreadth(u))),
      this.block(SRC.sectors, need((u) => this.breadth.getSectorPerformance(u))),
    ]);
    return { indices, breadth, sectors };
  }

  /**
   * One instrument's context, cached per underlying and shared by concurrent builds (like the pulse):
   * 60 s when every block is present, ~10 s when one is unavailable.
   */
  private instrument(underlying: string, owner: string | null, now: Date, packetStartedAt: number): Promise<Record<string, unknown>> {
    const at = Date.now();
    const hit = this.instruments.get(underlying);
    if (hit && at - hit.at < hit.ttl) return hit.promise;
    for (const [k, v] of this.instruments) if (at - v.at >= v.ttl) this.instruments.delete(k);
    const promise = this.buildInstrument(underlying, owner, now, packetStartedAt);
    const entry: CacheEntry<Record<string, unknown>> = { at, ttl: INSTRUMENT_CACHE_MS, promise };
    this.instruments.set(underlying, entry);
    void promise.then((r) => {
      if (hasUnavailable(r)) entry.ttl = UNAVAILABLE_CACHE_MS;
    });
    return promise;
  }

  /**
   * The named instrument's own price (index / NSE cash / MCX front-month future): the live quote plus
   * previous-session, 20-session volume and 60-session range stats from daily bars, and the last closed
   * 15m bars. Cached per underlying like the pulse (60 s; 10 s when unavailable), shared by concurrent
   * posts; daily bars are fetched once per instrument per IST session day. Every broker read is raced
   * against the packet deadline. Present only when the live quote arrived; missing bars leave nulls and
   * a `missing` reason.
   */
  private quote(underlying: string, owner: string | null, now: Date, packetStartedAt: number): Promise<PacketBlock> {
    const at = Date.now();
    const hit = this.quoteCache.get(underlying);
    if (hit && at - hit.at < hit.ttl) return hit.promise;
    for (const [k, v] of this.quoteCache) if (at - v.at >= v.ttl) this.quoteCache.delete(k);
    // A safety net only: fetchQuote's own broker reads end by the packet deadline.
    const promise = this.block(SRC.quote, () => this.fetchQuote(underlying, owner, now, packetStartedAt), this.cfg.packetMs + SAFETY_MARGIN_MS);
    const entry: CacheEntry<PacketBlock> = { at, ttl: QUOTE_CACHE_MS, promise };
    this.quoteCache.set(underlying, entry);
    void promise.then((r) => {
      if (r.status === 'unavailable') entry.ttl = UNAVAILABLE_CACHE_MS;
    });
    return promise;
  }

  private async fetchQuote(underlying: string, owner: string | null, now: Date, packetStartedAt: number): Promise<unknown> {
    if (!owner) throw new Error('no owner user id (HUB_OWNER_USER_ID) to quote with');
    const ref = infoRefOf(underlying, null, null, now) ?? (await this.lookupRef(underlying, now));
    if (!ref) throw new Error(`no instrument for ${underlying} in the instrument master (index / NSE cash / MCX front future)`);
    const ms = Math.max(1, packetStartedAt + this.cfg.packetMs - Date.now());
    const bars = this.bars;
    const [ltp, daily, m15] = await Promise.all([
      this.block(
        SRC.quote,
        async () => {
          const q = (await this.quotes.resolveQuotes(owner, [{ token: ref.token, exchange: ref.exchange, symbol: underlying }])).get(ref.token);
          if (!q || !(q.ltp > 0)) throw new Error(`no live quote for ${ref.exchange}:${ref.token}`);
          return q;
        },
        ms,
      ),
      this.block(
        'daily bars',
        async () => {
          if (!bars) throw new Error('no daily bar loader');
          return this.dailyBars(bars, ref, now);
        },
        ms,
      ),
      this.block(
        '15m bars',
        async () => {
          if (!bars?.intraday15m) throw new Error('no 15m bar loader');
          return bars.intraday15m(ref.exchange, ref.token, new Date(now.getTime() - QUOTE_15M_DAYS * DAY_MS), now);
        },
        ms,
      ),
    ]);
    if (ltp.status !== 'present') throw new Error(ltp.reason);
    const missing: string[] = [];
    if (daily.status !== 'present') missing.push(`daily bars: ${daily.reason}`);
    if (m15.status !== 'present') missing.push(`15m bars: ${m15.reason}`);
    return readerQuote({
      exchange: ref.exchange,
      q: ltp.value as QuoteLtp,
      daily: daily.status === 'present' ? (daily.value as DailyBar[]) : null,
      bars15m: m15.status === 'present' ? (m15.value as Bar15m[]) : null,
      today: istYmd(now),
      now,
      missing,
    });
  }

  /** Stock / commodity → its NSE cash line / MCX front-month future via the vocabulary + instrument master. */
  private async lookupRef(underlying: string, now: Date): Promise<{ exchange: string; token: string } | null> {
    const [vocab, master] = await Promise.all([
      this.vocab ? this.vocab.get().catch(() => null) : Promise.resolve(null),
      this.master ? this.master.rows().catch(() => null) : Promise.resolve(null),
    ]);
    return infoRefOf(underlying, vocab, master, now);
  }

  /** Daily bars for one instrument, fetched once per IST session day; a failed or empty fetch is not kept. */
  private dailyBars(bars: InfoBars, ref: { exchange: string; token: string }, now: Date): Promise<DailyBar[]> {
    const key = `${ref.exchange}:${ref.token}`;
    const day = istYmd(now);
    const hit = this.dailyCache.get(key);
    if (hit && hit.day === day) return hit.promise;
    for (const [k, v] of this.dailyCache) if (v.day !== day) this.dailyCache.delete(k);
    const promise = bars.daily(ref.exchange, ref.token, new Date(now.getTime() - QUOTE_DAILY_DAYS * DAY_MS), now).then((rows) => {
      if (!rows?.length) throw new Error('no daily bars returned');
      return rows;
    });
    const entry = { day, promise };
    this.dailyCache.set(key, entry);
    promise.catch(() => {
      if (this.dailyCache.get(key) === entry) this.dailyCache.delete(key);
    });
    return promise;
  }

  private maxBuilds(): number {
    const n = this.cfg.maxInstrumentBuilds;
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_INSTRUMENT_BUILDS;
  }

  /**
   * A permit for one reader instrument build (MESSAGE_READER_MAX_INSTRUMENT_BUILDS in flight, process-wide),
   * or null when none frees before `deadlineAt` (the packet deadline). Resolves to an idempotent release.
   */
  private acquireBuild(deadlineAt: number): Promise<(() => void) | null> {
    const permit = () => {
      this.buildsInFlight++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.buildsInFlight--;
        this.buildWaiters.shift()?.();
      };
    };
    if (this.buildsInFlight < this.maxBuilds() && this.buildWaiters.length === 0) return Promise.resolve(permit());
    const waitMs = deadlineAt - Date.now();
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const admit = () => {
        clearTimeout(timer);
        resolve(permit());
      };
      const timer = setTimeout(() => {
        const i = this.buildWaiters.indexOf(admit);
        if (i >= 0) this.buildWaiters.splice(i, 1);
        resolve(null);
      }, waitMs);
      timer.unref?.();
      this.buildWaiters.push(admit);
    });
  }

  /**
   * The judge's market packet for one named underlying. The post names an underlying, not a contract,
   * so it is read as a futures signal on it: exchange from signal-trader's own segment rule (NFO / BFO /
   * MCX); a stock's spot then comes from its cash line, as for a stock-futures signal. The judge's blocks
   * are each capped at the packet time box (deadlineMs), so one slow block never discards the others.
   * An MCX future is its own underlying, so its spot is the front-month future's LTP: looked up first
   * (half the box at most), then passed as `ltp`; a miss builds without it and says so in `frontFuture`.
   */
  private async buildInstrument(underlying: string, owner: string | null, now: Date, packetStartedAt: number): Promise<Record<string, unknown>> {
    const release = await this.acquireBuild(packetStartedAt + this.cfg.packetMs);
    if (!release) {
      const reason = `reader build limit: ${this.maxBuilds()} instrument builds still in flight at the packet deadline (MESSAGE_READER_MAX_INSTRUMENT_BUILDS)`;
      const context: PacketBlock = { status: 'unavailable', source: SRC.instrument, reason };
      return { context };
    }
    const started = Date.now();
    const exchange = segmentFor({ underlying, instrumentKind: 'FUT' });
    // Shadow reads never build the structure / level book (owner's broker session); MESSAGE_READER_SKIP_STRUCTURE=false restores it.
    const skip = this.cfg.skipStructure === false ? undefined : ['structure'];
    const r = await this.block(
      SRC.instrument,
      // The permit is held until the build itself settles (not the safety race), so abandoned work still counts.
      () => this.holding(release, async () => {
        let ltp: number | undefined;
        let frontFuture: PacketBlock | undefined;
        if (exchange === 'MCX') {
          frontFuture = await this.block(
            SRC.frontFuture,
            async () => {
              const q = await this.context.underlyingQuote(underlying, 'MCX', owner, now);
              if (q === null) throw new Error('no front-month future quote (instrument master or owner session); structure built without a spot');
              return { ltp: q };
            },
            Math.floor(this.cfg.packetMs / 2),
          );
          if (frontFuture.status === 'present') ltp = (frontFuture.value as { ltp: number }).ltp;
        }
        const deadlineMs = Math.max(1, this.cfg.packetMs - (Date.now() - started));
        const ctx = await this.context.build({ underlying, kind: 'FUT', exchange, ownerUserId: owner, now, deadlineMs, ...(skip ? { skip } : {}), ...(ltp !== undefined ? { ltp } : {}) });
        return frontFuture ? { ...ctx, frontFuture } : ctx;
      }),
      // A safety net only: the judge's own blocks already end by the deadline.
      this.cfg.packetMs + SAFETY_MARGIN_MS,
    );
    return r.status === 'present' ? (r.value as Record<string, unknown>) : { context: r };
  }

  private async holding<T>(release: () => void, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Runs one source against the packet time box (or `ms`); never throws. */
  private async block(source: string, read: () => Promise<unknown>, ms = this.cfg.packetMs): Promise<PacketBlock> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      timer.unref?.();
    });
    try {
      const value = await Promise.race([read(), timeout]);
      return { status: 'present', source, value };
    } catch (err) {
      return { status: 'unavailable', source, reason: errText(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
