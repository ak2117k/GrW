import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OptionsChainView } from '@td/shared/types';
import { MARKET_QUOTE_RESOLVER, type QuoteResolverLike } from '../../market-data/services/batch-quotes.service';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { quoteIsStale } from '../../message-reader/domain/reader-quote';
import type { Claim } from '../../message-reader/domain/reading.types';
import { DeadlinePermits, type PacketBlock } from '../../message-reader/services/reader-packet.service';
import { newsKeyFor } from '../../news/services/underlying-news-aliases';
import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import type { Vocabulary } from '../../signal-intake/domain/vocabulary';
import { SignalVocabularyService } from '../../signal-intake/services/signal-vocabulary.service';
import { infoRefOf, SIGNAL_INFO_BARS, SIGNAL_INFO_MASTER, type InfoBars } from '../../signal-intake/services/signal-outcome.service';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import { AI_SETUPS_CONFIG, type AiSetupsConfig } from '../ai-setups.config';
import { ANTI_CHASE_ATR, MAX_SPREAD_PCT, MIN_REWARD_RISK, setupCeilingFor } from '../domain/setup-checks';
import {
  bars15mView,
  chainLotSize,
  chainRows,
  dailyStats,
  masterLotSize,
  nearestNonExpiryDay,
  timeToClose,
  type RawBar15m,
  type TimeToClose,
} from '../domain/setup-packet';

/** The two database reads the setup packet needs; the ai-setups repository implements it (Task 4). */
export const SETUP_PACKET_SOURCES = Symbol('SETUP_PACKET_SOURCES');
/** The option chain (OptionsChainService: `useExisting`). */
export const SETUP_CHAIN_SOURCE = Symbol('SETUP_CHAIN_SOURCE');
/** Headlines per symbol (NewsAggregatorService: `useExisting`). */
export const SETUP_NEWS_SOURCE = Symbol('SETUP_NEWS_SOURCE');

export interface SetupPacketSources {
  /** The channel's call / claim record (self-review byChannel, claim scoring); null when none exists yet. */
  channelRecord(channelId: string): Promise<unknown | null>;
  /** Today's desk: AI setups so far and the open / pending trades and setups (any underlying). */
  deskToday(sessionDate: string, underlying: string): Promise<{ setupsToday: number; openTrades: unknown[] } & Record<string, unknown>>;
}

export interface SetupChainSource {
  getExpiries(underlying: string): Promise<string[]>;
  getChainView(underlying: string, expiry: string): Promise<OptionsChainView>;
}

export interface SetupNewsSource {
  getNewsForSymbol(symbol: string): Promise<Array<{ title: string; source: string; sentiment?: unknown; publishedAt: Date }>>;
}

/** The reading the claim came from (only what the packet needs). */
export interface SetupReadingRef {
  channelId: string;
}

export interface SetupPacket {
  at: string;
  underlying: string;
  /** Where the underlying's options trade (NFO / BFO / MCX). */
  optionExchange: string;
  /**
   * Which way the verified claim points — labels only, no numbers. The claim's text, its read-time evidence and
   * the reading summary are NOT in the packet (they are read-time, not present state); SetupLlm sends them in the
   * user message as context. `claim` is never an evidence source (checkSetup rejects it).
   */
  claim: { subject: string; bias: string; horizon: string; claimType: string; verdict: string };
  /** The code rules every setup must pass (plan Global Constraints). */
  rules: { optionBuysOnly: true; minRewardRisk: number; antiChaseAtr15m: number; maxSpreadPct: number; minOi: number; maxSetupsPerDay: number };
  quote: PacketBlock;
  daily60: PacketBlock;
  bars15m: PacketBlock;
  chain: PacketBlock;
  news60m: PacketBlock;
  channelRecord: PacketBlock;
  deskToday: PacketBlock;
  timeToClose: { status: 'present'; source: string; value: TimeToClose };
}

/** Setup packet builds whose broker reads (quote, bars, chain) may run at once, process-wide. */
export const MAX_SETUP_PACKET_BUILDS = 2;
const NEWS_WINDOW_MS = 60 * 60_000;
const MAX_HEADLINES = 8;
/** Daily bars fetched: 60 prior sessions + weekends / holidays. Kept per instrument for the IST day. */
const DAILY_DAYS = 100;
/** 15m bars fetched: enough to reach the previous session across a long weekend. */
const BARS_15M_DAYS = 6;
const DAY_MS = 86_400_000;

const SRC = {
  quote: 'market-quote-resolver (owner session; index / NSE cash / MCX front future)',
  daily: 'owner daily bars (60 sessions before today)',
  bars15m: 'owner 15m bars (today + previous session, closed bars only)',
  chain: 'options-chain (nearest non-expiry-day expiry, ATM ± 5)',
  news: 'news-aggregator (last 60 min)',
  channel: 'channel record (self-review / claim scoring)',
  desk: 'ai_setups + trades (today)',
  time: 'clock (IST)',
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const off = (source: string, reason: string): PacketBlock => ({ status: 'unavailable', source, reason });

interface LiveQuote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date | string | number;
}

/**
 * Builds the data packet the setup AI plans against (spec §5.2): the underlying's live quote, 60 daily sessions,
 * 15m bars of today + the previous session (ATR15m, VWAP), the option chain at the nearest non-expiry-day
 * expiry (ATM ± 5: LTP, OI, volume, bid / ask spread, delta), the last 60 min of news, the channel's record,
 * today's desk (setups, open trades, the ₹ loss ceiling) and the time left. Every block is `present` or
 * `unavailable` with its reason, never a throw; the whole packet ends by AI_SETUP_PACKET_MS.
 *
 * Broker load (the owner's Angel session is scarce): at most 2 packet builds touch the broker at once
 * (a build that gets no permit by the deadline marks its broker blocks `setup packet limit` and makes no broker
 * call); the bars are read only after a fresh live quote arrived; daily bars are fetched once per instrument per
 * IST day. Never 1m bars.
 */
@Injectable()
export class SetupPacketService {
  private readonly permits = new DeadlinePermits(MAX_SETUP_PACKET_BUILDS);
  private readonly dailyCache = new Map<string, { day: string; promise: Promise<DailyBar[]> }>();

  constructor(
    @Inject(MARKET_QUOTE_RESOLVER) private readonly quotes: QuoteResolverLike,
    @Inject(SETUP_PACKET_SOURCES) private readonly sources: SetupPacketSources,
    @Inject(AI_SETUPS_CONFIG) private readonly cfg: AiSetupsConfig,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: Pick<SignalTraderConfig, 'ownerUserId'>,
    @Optional() @Inject(SIGNAL_INFO_BARS) private readonly bars?: InfoBars,
    @Optional() @Inject(SIGNAL_INFO_MASTER) private readonly master?: { rows(): Promise<readonly unknown[] | null> },
    @Optional() @Inject(SignalVocabularyService) private readonly vocab?: { get(): Promise<Vocabulary> },
    @Optional() @Inject(SETUP_CHAIN_SOURCE) private readonly chain?: SetupChainSource,
    @Optional() @Inject(SETUP_NEWS_SOURCE) private readonly news?: SetupNewsSource,
  ) {}

  async build(i: { underlying: string; claim: Claim; reading: SetupReadingRef; now: Date }): Promise<{ packet: SetupPacket; ms: number }> {
    const started = Date.now();
    const deadlineAt = started + this.cfg.packetMs;
    const u = i.underlying.trim().toUpperCase();
    const optionExchange = segmentFor({ underlying: u, instrumentKind: 'FUT' });
    const today = istYmd(i.now);
    const [market, news60m, channelRecord, deskToday] = await Promise.all([
      this.market(u, optionExchange, i.now, deadlineAt),
      this.block(SRC.news, () => this.recentNews(u, i.now), deadlineAt),
      this.block(
        SRC.channel,
        async () => {
          const r = await this.sources.channelRecord(i.reading.channelId);
          if (r === null || r === undefined) throw new Error('no record for this channel yet (not scored by self-review / claim scoring)');
          return r;
        },
        deadlineAt,
      ),
      this.block(
        SRC.desk,
        async () => ({ ...(await this.sources.deskToday(today, u)), maxSetupsPerDay: this.cfg.maxPerDay, ceilingRupees: setupCeilingFor(u, optionExchange) }),
        deadlineAt,
      ),
    ]);
    const c = i.claim;
    const packet: SetupPacket = {
      at: i.now.toISOString(),
      underlying: u,
      optionExchange,
      claim: { subject: c.subject, bias: c.bias, horizon: c.horizon, claimType: c.claimType, verdict: c.verdict },
      rules: {
        optionBuysOnly: true,
        minRewardRisk: MIN_REWARD_RISK,
        antiChaseAtr15m: ANTI_CHASE_ATR,
        maxSpreadPct: MAX_SPREAD_PCT,
        minOi: this.cfg.minOi,
        maxSetupsPerDay: this.cfg.maxPerDay,
      },
      ...market,
      news60m,
      channelRecord,
      deskToday,
      timeToClose: { status: 'present', source: SRC.time, value: timeToClose(optionExchange, i.now) },
    };
    return { packet, ms: Date.now() - started };
  }

  /** The broker-backed blocks (quote, daily60, bars15m, chain) under one of the 2 process-wide permits. */
  private async market(u: string, optionExchange: string, now: Date, deadlineAt: number): Promise<Pick<SetupPacket, 'quote' | 'daily60' | 'bars15m' | 'chain'>> {
    const owner = this.traderCfg.ownerUserId;
    const all = (reason: string) => ({ quote: off(SRC.quote, reason), daily60: off(SRC.daily, reason), bars15m: off(SRC.bars15m, reason), chain: off(SRC.chain, reason) });
    if (!owner) return all('no owner user id (HUB_OWNER_USER_ID) to read the broker with');
    const release = await this.permits.acquire(deadlineAt);
    if (!release) return all(`setup packet limit: ${MAX_SETUP_PACKET_BUILDS} setup packet builds still in flight at the packet deadline`);
    try {
      // The chain centres on its own spot; without one it waits for the live quote's LTP (null on any miss).
      let setSpot: (v: number | null) => void = () => undefined;
      const spot = new Promise<number | null>((r) => (setSpot = r));
      const underlying = (async () => {
        const refBlock = await this.block('instrument master', async () => infoRefOf(u, null, null, now) ?? (await this.lookupRef(u, now)), deadlineAt);
        const ref = refBlock.status === 'present' ? (refBlock.value as { exchange: string; token: string } | null) : null;
        if (!ref) {
          setSpot(null);
          const reason =
            refBlock.status === 'present' ? `no instrument for ${u} in the instrument master (index / NSE cash / MCX front future)` : `instrument lookup: ${refBlock.reason}`;
          return { quote: off(SRC.quote, reason), daily60: off(SRC.daily, reason), bars15m: off(SRC.bars15m, reason) };
        }
        const quote = await this.block(SRC.quote, () => this.liveQuote(owner, u, ref, now), deadlineAt);
        setSpot(quote.status === 'present' ? (quote.value as { ltp: number }).ltp : null);
        if (quote.status !== 'present') {
          // A failed / stale / hung quote puts no work on the owner's historical lane.
          const reason = `skipped: no fresh live quote (${quote.reason})`;
          return { quote, daily60: off(SRC.daily, reason), bars15m: off(SRC.bars15m, reason) };
        }
        const [daily60, bars15m] = await Promise.all([
          this.block(SRC.daily, async () => dailyStats(await this.dailyBars(ref, now), istYmd(now)), deadlineAt),
          this.block(
            SRC.bars15m,
            async () => {
              if (!this.bars?.intraday15m) throw new Error('no 15m bar loader');
              const raw = (await this.bars.intraday15m(ref.exchange, ref.token, new Date(now.getTime() - BARS_15M_DAYS * DAY_MS), now)) as RawBar15m[];
              const view = bars15mView(raw ?? [], ref.exchange, now, istYmd(now));
              if (view.bars.length === 0) throw new Error('no closed 15m session bars returned');
              return view;
            },
            deadlineAt,
          ),
        ]);
        return { quote, daily60, bars15m };
      })();
      const chain = this.block(SRC.chain, () => this.chainBlock(u, optionExchange, now, spot), deadlineAt);
      const [blocks, chainBlock] = await Promise.all([underlying, chain]);
      return { ...blocks, chain: chainBlock };
    } finally {
      // Every read above is raced against the deadline, so the permit is back by then at the latest.
      release();
    }
  }

  private async liveQuote(owner: string, u: string, ref: { exchange: string; token: string }, now: Date): Promise<unknown> {
    const q = (await this.quotes.resolveQuotes(owner, [{ token: ref.token, exchange: ref.exchange, symbol: u }])).get(ref.token) as LiveQuote | undefined;
    if (!q || !(q.ltp > 0)) throw new Error(`no live quote for ${ref.exchange}:${ref.token}`);
    const at = new Date(q.timestamp);
    if (quoteIsStale(ref.exchange, at, now)) throw new Error(`stale quote: last update ${at.toISOString()} is over 5 min old during the session`);
    return { exchange: ref.exchange, ltp: q.ltp, open: q.open, dayHigh: q.high, dayLow: q.low, volume: q.volume, at: at.toISOString() };
  }

  /**
   * The chain at the nearest expiry after today (an expiry-day contract is never offered): ATM ± 5 strikes
   * around the chain's spot (else the underlying's live quote), each leg's LTP, OI, volume, bid / ask, spread %
   * and delta (null when the chain has no Greek), plus the option lot size. Only a fresh chain is present.
   */
  private async chainBlock(u: string, optionExchange: string, now: Date, spot: Promise<number | null>): Promise<unknown> {
    if (!this.chain) throw new Error('no option chain source');
    const today = istYmd(now);
    const expiry = nearestNonExpiryDay(await this.chain.getExpiries(u), today);
    if (!expiry) throw new Error(`no listed ${u} option expiry after today (${today})`);
    const view = await this.chain.getChainView(u, expiry);
    if (view.status !== 'fresh') {
      throw new Error(`chain ${view.status}${view.unavailable ? ` (${view.unavailable})` : ''}, prices at ${view.at}: bid / ask and OI are not current`);
    }
    const center = view.spotPrice ?? (await spot);
    if (!center || !(center > 0)) throw new Error('no spot to centre the chain on');
    const rows = chainRows(view.chain, center);
    if (rows.length === 0) throw new Error(`no strikes listed for ${u} ${expiry}`);
    let lotSize = chainLotSize(view.chain);
    if (lotSize === null && this.master) {
      const m = await this.master.rows().catch(() => null);
      lotSize = m ? masterLotSize(m, u, optionExchange, expiry) : null;
    }
    return { expiry, exchange: optionExchange, spot: center, lotSize, at: view.at, greeks: view.greeks ?? null, rows };
  }

  private async recentNews(u: string, now: Date): Promise<unknown> {
    if (!this.news) throw new Error('no news source');
    const key = newsKeyFor(u).key ?? u;
    const cutoff = now.getTime() - NEWS_WINDOW_MS;
    const fresh = (await this.news.getNewsForSymbol(key)).filter((a) => a.publishedAt.getTime() >= cutoff && a.publishedAt.getTime() <= now.getTime());
    // An empty list is a fact (no headline in the last hour), not an outage.
    return {
      key,
      count: fresh.length,
      headlines: fresh.slice(0, MAX_HEADLINES).map((a) => ({ title: a.title, source: a.source, sentiment: a.sentiment ?? null, publishedAt: a.publishedAt.toISOString() })),
    };
  }

  /** Stock / commodity → its NSE cash line / MCX front-month future via the vocabulary + instrument master. */
  private async lookupRef(u: string, now: Date): Promise<{ exchange: string; token: string } | null> {
    const [vocab, master] = await Promise.all([
      this.vocab ? this.vocab.get().catch(() => null) : Promise.resolve(null),
      this.master ? this.master.rows().catch(() => null) : Promise.resolve(null),
    ]);
    return infoRefOf(u, vocab, master, now);
  }

  /** Daily bars for one instrument, fetched once per IST day; a failed or empty fetch is not kept. */
  private dailyBars(ref: { exchange: string; token: string }, now: Date): Promise<DailyBar[]> {
    const bars = this.bars;
    if (!bars) return Promise.reject(new Error('no daily bar loader'));
    const key = `${ref.exchange}:${ref.token}`;
    const day = istYmd(now);
    const hit = this.dailyCache.get(key);
    if (hit && hit.day === day) return hit.promise;
    for (const [k, v] of this.dailyCache) if (v.day !== day) this.dailyCache.delete(k);
    const promise = bars.daily(ref.exchange, ref.token, new Date(now.getTime() - DAILY_DAYS * DAY_MS), now).then((rows) => {
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

  /** Runs one source against the packet deadline; never throws. */
  private async block(source: string, read: () => Promise<unknown>, deadlineAt: number): Promise<PacketBlock> {
    const ms = Math.max(1, deadlineAt - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.cfg.packetMs} ms packet time box`)), ms);
      timer.unref?.();
    });
    try {
      const value = await Promise.race([read(), timeout]);
      return { status: 'present', source, value };
    } catch (err) {
      return off(source, errText(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
