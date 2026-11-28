import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SETUP_WATCH_MARKET, type SetupWatchMarket, type WatchRef } from '../../ai-setups/services/setup-watch.service';
import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import type { LevelBook } from '../../signal-generator/types/level-book.types';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { findContract, listedExpiries } from '../../signal-intake/domain/contract';
import { SIGNAL_INFO_BARS, type InfoBars } from '../../signal-intake/services/signal-outcome.service';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import type { DeskMarketPort } from '../services/desk-state.service';
import { inVenueSession, istDayOf, rollToSessionBuckets, sessionOnlyBars, type OhlcBar } from '../../exit-discipline/session-bars';

const MIN = 60_000;
const BAR_MS = 15 * MIN;
/** 15m bars read for the trend (3 sessions of NSE, ~1 of MCX). */
const TREND_LOOKBACK_MS = 4 * 24 * 60 * MIN;
const EMA_LEN = 20;
/** An OI row older than this is not "the chain now". */
const OI_FRESH_MS = 30 * MIN;

export interface TrendRead {
  tag: 'UP' | 'DOWN' | 'FLAT' | null;
  text: string | null;
}

/** EMA of the closes. */
export function ema(values: readonly number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  for (const v of values) out.push(out.length === 0 ? v : v * k + out[out.length - 1] * (1 - k));
  return out;
}

/**
 * The 15m trend tag from closed bars: close vs EMA20 and the EMA's slope over the last 4 bars.
 * UP = close above a rising EMA, DOWN = below a falling one, otherwise FLAT. Fewer than EMA_LEN bars = null.
 */
export function trendOf(bars: readonly Bar15m[]): TrendRead {
  if (bars.length < EMA_LEN) return { tag: null, text: null };
  const closes = bars.map((b) => b.close);
  const e = ema(closes, EMA_LEN);
  const last = closes[closes.length - 1];
  const eNow = e[e.length - 1];
  const ePrev = e[Math.max(0, e.length - 5)];
  const rising = eNow > ePrev;
  const falling = eNow < ePrev;
  const tag = last > eNow && rising ? 'UP' : last < eNow && falling ? 'DOWN' : 'FLAT';
  const r = (n: number) => Math.round(n * 100) / 100;
  return { tag, text: `${tag} (15m close ${r(last)} vs EMA20 ${r(eNow)}, EMA ${rising ? 'rising' : falling ? 'falling' : 'flat'})` };
}

/** Angel publishes a closed 15m bar a few seconds after the close; ask after this grace. */
const PUBLISH_GRACE_MS = 20_000;
/** An empty or failed fetch is retried after this (not held until the next bar). */
const RETRY_EMPTY_MS = 60_000;

/**
 * When a fetch made at `t` can next return a NEW closed 15m bar: the next bar close after (t − grace), plus the
 * grace. A fetch just after a close but before its publish grace is due again at that same close + grace.
 * IST is UTC+5:30, so 15m bars on the epoch grid are the IST session grid (NSE 09:15, MCX 09:00).
 */
export function nextBarReadyAt(t: number): number {
  return Math.floor((t - PUBLISH_GRACE_MS) / BAR_MS) * BAR_MS + BAR_MS + PUBLISH_GRACE_MS;
}

/**
 * The pre-warm pass runs at bar close + 50 s, not + 20 s: the sentinel / MBM refreshers hit the shared historical
 * gate right at close + 20 s, and the desk's burst must not land in the same window.
 */
export const PREWARM_OFFSET_MS = 50_000;
export function nextPrewarmAt(t: number): number {
  return Math.floor((t - PREWARM_OFFSET_MS) / BAR_MS) * BAR_MS + BAR_MS + PREWARM_OFFSET_MS;
}

/** Live-feed bars are trusted only while the newest 1m bar ENDED within this of now (venue open). */
const LIVE_STALE_MS = 3 * MIN;
/** …and its close is within this fraction of Angel's live price. */
const LIVE_LTP_TOLERANCE = 0.005;
/** …and the last closed 15m bucket holds at least this many of its 15 minutes. */
const LIVE_MIN_MINUTES = 12;

/**
 * Should the desk trust the live-feed 15m bars? Every check must pass, else the caller asks Angel's historical
 * API: (1) the newest session bar is fresh while the venue is open (a frozen line = 11-03 crude stuck at 9218);
 * (2) its close agrees with Angel's live price (no live price = cannot verify = no); (3) the last closed 15m
 * bucket is near complete (no gap-built bars); (4) at least EMA_LEN closed buckets, enough for the trend.
 * `ones` are SESSION 1-minute bars; the returned 15m bars include the forming one (callers keep closed only).
 */
export function liveFeedGate(
  ones: readonly OhlcBar[],
  exchange: string,
  t: number,
  ltp: number | null,
): { ok: true; bars: Bar15m[] } | { ok: false; reason: string } {
  if (ones.length === 0) return { ok: false, reason: 'no live-feed bars' };
  const newest = ones.reduce((a, b) => (b.ts > a.ts ? b : a));
  if (inVenueSession(t, exchange) && t - (newest.ts + MIN) > LIVE_STALE_MS) return { ok: false, reason: 'live feed stale' };
  if (ltp === null || !(ltp > 0)) return { ok: false, reason: 'no live price to verify against' };
  if (Math.abs(newest.close - ltp) / ltp > LIVE_LTP_TOLERANCE) return { ok: false, reason: `live-feed close ${newest.close} vs live price ${ltp}` };
  const buckets = rollToSessionBuckets(ones, exchange, 15);
  const closed = buckets.filter((b) => b.ts + BAR_MS <= t);
  if (closed.length < EMA_LEN) return { ok: false, reason: `only ${closed.length} closed 15m bars` };
  const last = closed[closed.length - 1];
  const minutes = ones.filter((b) => b.ts >= last.ts && b.ts < last.ts + BAR_MS).length;
  if (minutes < LIVE_MIN_MINUTES) return { ok: false, reason: `last 15m bar built from ${minutes}/15 minutes` };
  return { ok: true, bars: buckets.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null })) };
}

/** A cached 15m bar: OHLC plus the bar's traded volume when the source has it (an index has none). */
export type DeskBar = Bar15m & { volume?: number | null };

/** Closed bars only (a bar counts once its 15 minutes are over). */
const closedBy = <B extends Bar15m>(bars: readonly B[], at: Date) => bars.filter((b) => b.ts + BAR_MS <= at.getTime());

const typical = (b: Bar15m) => (b.high + b.low + b.close) / 3;

/**
 * Session VWAP over today's CLOSED 15m bars: Σ(typical price × volume) / Σ volume. Prices come from `priceBars`;
 * the volume from `volumeBars` matched by bar start (the same bars when the line has its own volume; an index's
 * near-month future when the index has none). Null when no closed bar of today carries volume.
 */
export function sessionVwap(priceBars: readonly Bar15m[], volumeBars: readonly DeskBar[], now: Date): number | null {
  const dayStart = istDayStart(now).getTime();
  const vol = new Map<number, number>();
  for (const b of volumeBars) if (b.ts >= dayStart && Number(b.volume) > 0) vol.set(b.ts, Number(b.volume));
  let pv = 0;
  let v = 0;
  for (const b of closedBy(priceBars, now)) {
    if (b.ts < dayStart) continue;
    const w = vol.get(b.ts);
    if (!w) continue;
    pv += typical(b) * w;
    v += w;
  }
  return v > 0 ? pv / v : null;
}

/** One closed daily candle (IST trading day), the level-book builder's input. */
export interface DeskDaily {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A level book built from daily + 15m bars with the existing builder (LevelBookService.seedSession /
 * lockOpeningRange / updateFromTick on a private instance, never the shared map): PDH / PDL / prev close / ATR
 * from the daily candles before today (none → the previous session's 15m bars), today's opening range = the first
 * closed 15m bar of the VENUE's session (sessionOnlyBars: MCX 09:00–09:15, NSE/BSE 09:15–09:30 — the same window
 * LevelBookService.lazyLoad uses via sessionOpenHm), yesterday's OR = the previous session's first 15m bar, today's high / low
 * from today's closed bars, `vwap` as given. Null when there is no previous session at all.
 */
export function buildDeskLevelBook(input: {
  token: string;
  symbol: string;
  exchange: string;
  daily: readonly DeskDaily[];
  bars: readonly Bar15m[];
  now: Date;
  vwap: number | null;
}): LevelBook | null {
  const dayStart = istDayStart(input.now).getTime();
  const session = sessionOnlyBars(closedBy([...input.bars].sort((a, b) => a.ts - b.ts), input.now), input.exchange, 15);
  const today = session.filter((b) => b.ts >= dayStart);
  const before = session.filter((b) => b.ts < dayStart);
  const prevDayNo = before.length ? istDayOf(before[before.length - 1].ts) : null;
  const prevDay = prevDayNo === null ? [] : before.filter((b) => istDayOf(b.ts) === prevDayNo);
  let daily = input.daily.filter((d) => d.timestamp.getTime() < dayStart && [d.high, d.low, d.close].every(Number.isFinite));
  if (daily.length === 0 && prevDay.length > 0) {
    daily = [
      {
        timestamp: new Date(prevDayNo! * 86_400_000 - 330 * MIN),
        open: prevDay[0].open,
        high: Math.max(...prevDay.map((b) => b.high)),
        low: Math.min(...prevDay.map((b) => b.low)),
        close: prevDay[prevDay.length - 1].close,
        volume: 0,
      },
    ];
  }
  if (daily.length === 0) return null;
  const builder = new LevelBookService();
  builder.seedSession({ token: input.token, symbol: input.symbol, exchange: input.exchange, recentDailyCandles: [...daily].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()) });
  const last = today.length ? today[today.length - 1] : null;
  if (today.length) builder.lockOpeningRange(input.token, { high: today[0].high, low: today[0].low });
  const spot = last ? last.close : daily[daily.length - 1].close;
  builder.updateFromTick({ token: input.token, ltp: spot, volume: 0, timestamp: new Date(last ? last.ts + BAR_MS : input.now.getTime()) });
  const book = builder.getLevels(input.token);
  if (!book) return null;
  book.prevOrh = prevDay.length ? prevDay[0].high : null;
  book.prevOrl = prevDay.length ? prevDay[0].low : null;
  book.todayHigh = today.length ? Math.max(...today.map((b) => b.high)) : 0;
  book.todayLow = today.length ? Math.min(...today.map((b) => b.low)) : 0;
  book.vwap = input.vwap !== null && input.vwap > 0 ? input.vwap : 0;
  return book;
}

/** Underlyings pre-warmed besides the last packet's (DESK_PREWARM_UNDERLYINGS, comma list). */
export const DEFAULT_PREWARM = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER'] as const;
export function parsePrewarmList(raw: string | undefined): string[] {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...DEFAULT_PREWARM];
}
/** An underlying read within this long counts as "in the last packet" for the pre-warm. */
const SEEN_FRESH_MS = 60 * MIN;
const keyOf = (r: Pick<WatchRef, 'exchange' | 'token'>) => `${r.exchange.toUpperCase()}:${r.token}`;

/** IST midnight of `now`, as a UTC instant. */
function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + 330 * MIN);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * MIN);
}

/**
 * The desk packet's market reads (DeskMarketPort) over what the app already keeps: the AI setups market
 * (hub LTP + one quote batch, 15m bars), the in-memory level book, and the captured option chain
 * (oi_snapshots). No order, and no broker call beyond the setups market's own capped quote batch.
 * Every read returns null / [] instead of throwing, so one bad underlying never sinks the packet.
 *
 * W4 (2026-11-28): the 15m bars live in ONE in-process cache per (exchange, token), refreshed once per closed bar
 * and pre-warmed (boot + every closed bar, which covers each venue's open) for the configured list and the last
 * packet's underlyings, so a run never waits on a cold fetch. An underlying with no in-memory level book gets one
 * built from daily + 15m bars; an index's VWAP takes its volume from the near-month future.
 */
@Injectable()
export class DeskMarketAdapter implements DeskMarketPort, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('DeskMarketAdapter');
  private readonly refs = new Map<string, { ref: WatchRef | null; at: number }>();
  /** Underlying → last read (wall clock): "the last packet" for the pre-warm. */
  private readonly seen = new Map<string, number>();
  private readonly prewarmList = parsePrewarmList(process.env.DESK_PREWARM_UNDERLYINGS);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warming: Promise<string[]> | null = null;

  constructor(
    @Inject(SETUP_WATCH_MARKET) private readonly market: SetupWatchMarket,
    private readonly levelBooks: LevelBookService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(DESK_MANAGER_CONFIG) private readonly cfg?: Pick<DeskManagerConfig, 'mode'> | null,
    // Typed as the class (not a Pick) so Nest's DI metadata resolves it; the spec passes a fake.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** Boot pre-warm + one pass per closed 15m bar (close + 50 s, see nextPrewarmAt). Nothing while DESK_MANAGER=off. */
  onApplicationBootstrap(): void {
    if (!this.cfg || this.cfg.mode === 'off') return;
    void this.prewarm().catch(() => undefined);
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const t = this.clock();
    this.timer = setTimeout(() => {
      void this.prewarm()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, Math.max(1_000, nextPrewarmAt(t) - t));
    this.timer.unref?.();
  }

  /**
   * Fill the bar cache (and the daily statics a built level book needs) for `list` (default: the configured list)
   * plus every underlying read in the last hour, one after another (the historical gate is shared app-wide). A
   * cold line is always fetched; a warm one only while its venue is open or within one bar of its close, so the
   * closing bar lands and nothing is re-asked overnight. Returns the underlyings visited.
   */
  async prewarm(list?: readonly string[]): Promise<string[]> {
    if (this.warming) return this.warming;
    this.warming = this.prewarmOnce(list).finally(() => (this.warming = null));
    return this.warming;
  }

  private async prewarmOnce(list?: readonly string[]): Promise<string[]> {
    const t = this.clock();
    const now = new Date(t);
    const names = new Set((list ?? this.prewarmList).map((s) => s.toUpperCase()));
    for (const [u, at] of this.seen) if (t - at <= SEEN_FRESH_MS) names.add(u);
    const visited: string[] = [];
    const histBefore = this.historicalCalls;
    for (const u of names) {
      try {
        const ref = await this.ref(u, now, false);
        if (!ref) continue;
        visited.push(u);
        const lines = [ref];
        if (INDEX_UNDERLYINGS[u]) {
          const fut = await this.futureRef(u, now);
          if (fut) lines.push(fut);
        }
        for (const line of lines) {
          const hit = this.barCache.get(keyOf(line));
          const cold = !hit || hit.bars.length === 0;
          const live = this.market.isOpen(ref.exchange, now) || this.market.isOpen(ref.exchange, new Date(t - BAR_MS));
          if (cold || live) await this.loadRefBars(line, true, true);
        }
        if (!this.sharedBook(ref)) await this.dailyOf(ref, t);
      } catch (err) {
        this.logger.debug(`[desk] prewarm ${u}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.lastPrewarmHistoricalCalls = this.historicalCalls - histBefore;
    this.logger.log(`[desk] prewarm: ${visited.length} underlyings, ${this.lastPrewarmHistoricalCalls} historical calls`);
    return visited;
  }

  private async ref(underlying: string, now: Date, track = true): Promise<WatchRef | null> {
    const key = underlying.toUpperCase();
    if (track) this.seen.set(key, this.clock());
    const hit = this.refs.get(key);
    if (hit && now.getTime() - hit.at < 10 * MIN) return hit.ref;
    const ref = await this.market.underlyingRef(key, now).catch(() => null);
    this.refs.set(key, { ref, at: now.getTime() });
    return ref;
  }

  /** Wall clock for the bar cache (tests set it); `now` arguments stay the packet's own time. */
  clock: () => number = () => Date.now();
  /**
   * `retriedFor` = the closed bar (start ts) a publish-lag retry was already spent on: ONE early retry per closed
   * bar, then the entry waits for nextBarReadyAt (an illiquid line that never prints the bar is not re-asked every
   * minute on the shared historical gate).
   */
  private readonly barCache = new Map<string, { bars: DeskBar[]; validUntil: number; inflight: Promise<DeskBar[]> | null; retriedFor?: number | null }>();
  private infoBarsMemo: InfoBars | null | undefined;
  /** Historical-API fetches made (the pre-warm logs its share per pass). */
  historicalCalls = 0;
  lastPrewarmHistoricalCalls = 0;

  /** The owner-session bar loader (SIGNAL_INFO_BARS, with volume) when the app has it; else the setups market's. */
  private infoBars(): InfoBars | null {
    if (this.infoBarsMemo !== undefined) return this.infoBarsMemo;
    try {
      this.infoBarsMemo = (this.moduleRef?.get(SIGNAL_INFO_BARS, { strict: false }) as InfoBars | undefined) ?? null;
    } catch {
      this.infoBarsMemo = null;
    }
    if (!this.infoBarsMemo) {
      this.logger.warn('[desk] SIGNAL_INFO_BARS not found: 15m bars without volume (no VWAP from volume), no daily statics for built level books');
    }
    return this.infoBarsMemo;
  }

  private async loadBars(underlying: string): Promise<DeskBar[]> {
    const ref = await this.ref(underlying, new Date(this.clock()));
    return ref ? this.loadRefBars(ref) : [];
  }

  /**
   * THE shared 15m bar cache, for the desk reads and any other caller: one line's closed-and-forming 15m bars
   * (session minutes, with volume when the source has it), read from memory.
   */
  async bars15mOf(ref: WatchRef): Promise<DeskBar[]> {
    return this.loadRefBars(ref);
  }

  /**
   * One line's 15m bars, ONE fetch per (exchange, token) shared by day(), trend15m(), priceAt(), levels() and the
   * pre-warm, asked again only once a new 15m bar has closed and been published (nextBarReadyAt). A finished bar
   * never changes, so re-asking every 3-minute run only starved the shared 350 ms historical gate (2026-11-27:
   * 16 calls a run, every day/trend read timed out). While a refresh is in flight the previous bars are served; a
   * fetch slower than the packet's time box still lands in the cache. `force` refreshes a still-valid entry (the
   * pre-warm at a bar close); `wait` waits for that refresh even when bars are cached.
   */
  private async loadRefBars(ref: WatchRef, force = false, wait = false): Promise<DeskBar[]> {
    const key = keyOf(ref);
    const t = this.clock();
    const hit = this.barCache.get(key);
    if (hit?.inflight) return hit.bars.length && !wait ? hit.bars : hit.inflight;
    if (hit && !force && t < hit.validUntil) return hit.bars;
    const retriedBefore = hit?.retriedFor ?? null;
    const inflight = this.fetchBars(ref, t).then((bars) => {
      const fresh =
        bars.length > 0 ? { bars, ...this.validity(ref, bars, t, retriedBefore) } : { bars: hit?.bars ?? [], validUntil: t + RETRY_EMPTY_MS, retriedFor: retriedBefore };
      this.barCache.set(key, { ...fresh, inflight: null });
      return fresh.bars;
    });
    this.barCache.set(key, { bars: hit?.bars ?? [], validUntil: 0, inflight, retriedFor: retriedBefore });
    return hit?.bars.length && !wait ? hit.bars : inflight;
  }

  /**
   * Fresh bars are good until the next bar is published, unless the answer lacks the last closed bar of an open
   * venue (Angel publishes a few seconds late): then it is asked again after a minute, not 15 — ONCE per closed
   * bar; a second answer still without it waits for the next bar like any other.
   */
  private validity(ref: WatchRef, bars: readonly DeskBar[], t: number, retriedFor: number | null): { validUntil: number; retriedFor: number | null } {
    const lastClosedStart = Math.floor(t / BAR_MS) * BAR_MS - BAR_MS;
    const newest = bars[bars.length - 1].ts;
    let open = false;
    try {
      open = this.market.isOpen(ref.exchange, new Date(lastClosedStart)) && inVenueSession(lastClosedStart, ref.exchange);
    } catch {
      open = false;
    }
    if (open && newest < lastClosedStart && retriedFor !== lastClosedStart) return { validUntil: t + RETRY_EMPTY_MS, retriedFor: lastClosedStart };
    return { validUntil: nextBarReadyAt(t), retriedFor };
  }

  /** 1) Angel's live feed (the hub's tick bars) when it passes liveFeedGate; 2) else Angel's historical API. */
  private async fetchBars(ref: WatchRef, t: number): Promise<DeskBar[]> {
    const live = await this.liveFeedBars(ref, t).catch(() => null);
    if (live) return live;
    this.historicalCalls++;
    const raw = await this.historicalBars(ref, new Date(t - TREND_LOOKBACK_MS), new Date(t)).catch(() => [] as DeskBar[]);
    return [...(raw ?? [])].filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.close)).sort((a, b) => a.ts - b.ts);
  }

  private async historicalBars(ref: WatchRef, from: Date, to: Date): Promise<DeskBar[]> {
    const info = this.infoBars();
    if (info?.intraday15m) {
      const rows = await info.intraday15m(ref.exchange, ref.token, from, to);
      return (rows ?? []).map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null }));
    }
    return this.market.bars15m(ref, from, to);
  }

  private readonly futures = new Map<string, { day: string; ref: WatchRef | null }>();

  /** An index's near-month future (NFO; BFO for SENSEX / BANKEX) from the instrument master, once per IST day. */
  private async futureRef(underlying: string, now: Date): Promise<WatchRef | null> {
    const u = underlying.toUpperCase();
    const day = istYmd(now);
    const hit = this.futures.get(u);
    if (hit && hit.day === day) return hit.ref;
    const master = await this.market.master().catch(() => null);
    if (!master || master.length === 0) return null; // not loaded yet: ask again next time
    const seg = u === 'SENSEX' || u === 'BANKEX' ? 'BFO' : 'NFO';
    const expiry = listedExpiries(master, u, 'FUT', seg).find((e) => e >= day) ?? null;
    const c = expiry ? findContract(master, { underlying: u, instrumentKind: 'FUT', strike: null, expiry }, seg) : null;
    const ref = c ? { exchange: c.exchange, token: c.token, symbol: c.tradingsymbol } : null;
    this.futures.set(u, { day, ref });
    return ref;
  }

  private readonly dailies = new Map<string, { day: string; rows: DeskDaily[]; retryAt: number; inflight: Promise<DeskDaily[]> | null }>();

  /** The line's closed daily candles before today (owner session), fetched once per IST session (empty → retry in 60 s). */
  private async dailyOf(ref: WatchRef, t: number): Promise<DeskDaily[]> {
    const key = keyOf(ref);
    const day = istYmd(new Date(t));
    const hit = this.dailies.get(key);
    if (hit && hit.day === day) {
      if (hit.inflight) return hit.inflight;
      if (hit.rows.length > 0 || t < hit.retryAt) return hit.rows;
    }
    const info = this.infoBars();
    if (!info) return [];
    const midnight = istDayStart(new Date(t));
    const inflight = info
      .daily(ref.exchange, ref.token, new Date(midnight.getTime() - 30 * 24 * 60 * MIN), midnight)
      .catch(() => [] as Awaited<ReturnType<InfoBars['daily']>>)
      .then((raw) => {
        const rows = (raw ?? [])
          .filter((d) => typeof d.day === 'string' && d.day < day && [d.high, d.low, d.close].every((x) => Number.isFinite(Number(x))))
          .map((d) => ({ timestamp: new Date(Date.parse(`${d.day}T00:00:00+05:30`)), open: Number(d.close), high: Number(d.high), low: Number(d.low), close: Number(d.close), volume: Number(d.volume) || 0 }))
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        this.dailies.set(key, { day, rows, retryAt: t + RETRY_EMPTY_MS, inflight: null });
        return rows;
      });
    this.dailies.set(key, { day, rows: [], retryAt: 0, inflight });
    return inflight;
  }

  /** The app's in-memory level book for the line, when it has real statics. */
  private sharedBook(ref: WatchRef): LevelBook | null {
    const b = this.levelBooks.getLevels(ref.token);
    return b && b.pdh > 0 ? b : null;
  }

  /** Session VWAP from the line's own volume; an index (no volume) weights its bars by the near-month future's. */
  private async vwapOf(underlying: string, ref: WatchRef, now: Date): Promise<number | null> {
    const own = await this.loadRefBars(ref);
    const v = sessionVwap(own, own, now);
    if (v !== null || !INDEX_UNDERLYINGS[underlying.toUpperCase()]) return v;
    const fut = await this.futureRef(underlying, now);
    if (!fut) return null;
    return sessionVwap(own, await this.loadRefBars(fut), now);
  }

  /** The level book the desk reads: the shared in-memory one first, else one built from daily + 15m bars. */
  private async bookOf(underlying: string, ref: WatchRef, now: Date): Promise<LevelBook | null> {
    const shared = this.sharedBook(ref);
    if (shared) {
      if (shared.vwap > 0) return shared;
      const vwap = await this.vwapOf(underlying, ref, now);
      return { ...shared, vwap: vwap ?? 0 };
    }
    const [bars, daily, vwap] = await Promise.all([this.loadRefBars(ref), this.dailyOf(ref, this.clock()), this.vwapOf(underlying, ref, now)]);
    // One build per (underlying, session date, last closed bar): the inputs only change when a bar closes (the
    // daily count and VWAP are in the key so a late daily answer / future bar still rebuilds).
    const closed = closedBy(bars, now);
    const lastClosed = closed.length ? closed[closed.length - 1].ts : 0;
    const key = `${underlying.toUpperCase()}|${istYmd(now)}|${lastClosed}|${daily.length}|${vwap ?? ''}`;
    const memo = this.builtBooks.get(ref.token);
    if (memo && memo.key === key) {
      this.builtBookHits++;
      return memo.book;
    }
    const book = buildDeskLevelBook({ token: ref.token, symbol: underlying.toUpperCase(), exchange: ref.exchange, daily, bars, now, vwap });
    this.builtBooks.set(ref.token, { key, book });
    return book;
  }

  private readonly builtBooks = new Map<string, { key: string; book: LevelBook | null }>();
  /** Built-book cache hits (spec visibility). */
  builtBookHits = 0;

  /**
   * The underlying's 15m bars built from Angel's LIVE feed: the market hub writes every tick into 1-minute bars
   * (candles_1m), so this is the same Angel data with no historical-API call (2026-11-27: AB1021 "Too many
   * requests" app-wide starved the historical path). Session minutes only; null unless liveFeedGate passes.
   */
  private async liveFeedBars(ref: WatchRef, t: number): Promise<DeskBar[] | null> {
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; open: number; high: number; low: number; close: number; volume: bigint | number | null }>>`
      SELECT ts, open, high, low, close, volume FROM candles_1m
      WHERE exchange = ${ref.exchange} AND token = ${ref.token} AND ts >= ${new Date(t - TREND_LOOKBACK_MS)} AND ts <= ${new Date(t)}
      ORDER BY ts`;
    const ones: OhlcBar[] = sessionOnlyBars(
      (rows ?? []).map((r) => ({
        ts: (r.ts instanceof Date ? r.ts : new Date(r.ts)).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume == null ? null : Number(r.volume),
      })),
      ref.exchange,
    );
    const ltps = await this.market.ltps([ref], new Date(t)).catch(() => new Map<string, number>());
    const ltp = ltps.get(`${ref.exchange.toUpperCase()}:${ref.token}`) ?? null;
    const verdict = liveFeedGate(ones, ref.exchange, t, ltp);
    return verdict.ok ? verdict.bars : null;
  }

  private async bars(underlying: string, from: Date, now: Date): Promise<DeskBar[]> {
    const bars = await this.loadBars(underlying);
    return closedBy(
      bars.filter((b) => b.ts >= from.getTime()),
      now,
    );
  }

  async ltp(underlying: string, now: Date): Promise<number | null> {
    const ref = await this.ref(underlying, now);
    if (!ref) return null;
    const m = await this.market.ltps([ref], now).catch(() => new Map<string, number>());
    const v = m.get(`${ref.exchange.toUpperCase()}:${ref.token}`) ?? null;
    return v !== null && v > 0 ? v : null;
  }

  async day(underlying: string, now: Date) {
    const ref = await this.ref(underlying, now);
    if (!ref) return null;
    const book = this.sharedBook(ref);
    const today = await this.bars(underlying, istDayStart(now), now);
    const open = today.length ? today[0].open : null;
    const high = book?.todayHigh && book.todayHigh > 0 ? book.todayHigh : today.length ? Math.max(...today.map((b) => b.high)) : null;
    const low = book?.todayLow && book.todayLow > 0 ? book.todayLow : today.length ? Math.min(...today.map((b) => b.low)) : null;
    // The in-memory book's tick VWAP first; else today's session VWAP from the line's (or, for an index, the
    // near-month future's) 15m volume.
    const vwap = book?.vwap && book.vwap > 0 ? book.vwap : await this.vwapOf(underlying, ref, now);
    if (open === null && high === null && low === null && vwap === null) return null;
    return { open, high, low, vwap };
  }

  async trend15m(underlying: string, now: Date): Promise<string | null> {
    const bars = await this.bars(underlying, new Date(now.getTime() - TREND_LOOKBACK_MS), now);
    return trendOf(bars).text;
  }

  async levels(underlying: string, now: Date): Promise<number[]> {
    const ref = await this.ref(underlying, now);
    if (!ref) return [];
    const b = await this.bookOf(underlying, ref, now);
    if (!b) return [];
    const raw = [b.pdh, b.pdl, b.prevClose, b.orh, b.orl, b.prevOrh, b.prevOrl, b.vwap, ...(b.roundNumbers ?? []), ...(b.topVolStrikes ?? [])];
    const spot = b.spot > 0 ? b.spot : null;
    const uniq = [...new Set(raw.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0).map((x) => Math.round(x * 100) / 100))];
    return spot === null ? uniq.sort((x, y) => x - y) : uniq.sort((x, y) => Math.abs(x - spot) - Math.abs(y - spot));
  }

  /** The nearest expiry's call wall (max OI CE strike) and put wall (max OI PE strike) from the last 30 min of snapshots. */
  async chainWalls(underlying: string, now: Date): Promise<{ call: number | null; put: number | null } | null> {
    try {
      const since = new Date(now.getTime() - OI_FRESH_MS);
      const rows = await this.prisma.$queryRaw<Array<{ option_type: string; strike: number; oi: bigint }>>`
        WITH near AS (
          SELECT MIN(i.expiry) AS e FROM instruments i
          WHERE i.name = ${underlying.toUpperCase()} AND i."optionType" IN ('CE','PE') AND i.expiry >= ${istDayStart(now)}
        ), latest AS (
          SELECT DISTINCT ON (o."instrumentId") o."instrumentId", o.oi
          FROM oi_snapshots o JOIN instruments i ON i.id = o."instrumentId", near
          WHERE i.name = ${underlying.toUpperCase()} AND i.expiry = near.e AND o.timestamp >= ${since} AND o.timestamp <= ${now}
          ORDER BY o."instrumentId", o.timestamp DESC
        )
        SELECT i."optionType" AS option_type, i.strike, l.oi FROM latest l JOIN instruments i ON i.id = l."instrumentId"`;
      if (rows.length === 0) return null;
      const wall = (t: string) => {
        const side = rows.filter((r) => r.option_type === t && Number.isFinite(Number(r.strike)));
        if (side.length === 0) return null;
        return Number(side.reduce((a, b) => (Number(b.oi) > Number(a.oi) ? b : a)).strike);
      };
      return { call: wall('CE'), put: wall('PE') };
    } catch {
      return null;
    }
  }

  async priceAt(underlying: string, at: Date): Promise<number | null> {
    const bars = await this.bars(underlying, new Date(at.getTime() - 2 * 60 * MIN), at);
    return bars.length ? bars[bars.length - 1].close : null;
  }
}
