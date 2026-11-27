import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SETUP_WATCH_MARKET, type SetupWatchMarket, type WatchRef } from '../../ai-setups/services/setup-watch.service';
import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import type { DeskMarketPort } from '../services/desk-state.service';
import { inVenueSession, rollToSessionBuckets, sessionOnlyBars, type OhlcBar } from '../../exit-discipline/session-bars';

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
  return { ok: true, bars: buckets.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close })) };
}

/** Closed bars only (a bar counts once its 15 minutes are over). */
const closedBy = (bars: readonly Bar15m[], at: Date) => bars.filter((b) => b.ts + BAR_MS <= at.getTime());

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
 */
@Injectable()
export class DeskMarketAdapter implements DeskMarketPort {
  private readonly refs = new Map<string, { ref: WatchRef | null; at: number }>();

  constructor(
    @Inject(SETUP_WATCH_MARKET) private readonly market: SetupWatchMarket,
    private readonly levelBooks: LevelBookService,
    private readonly prisma: PrismaService,
  ) {}

  private async ref(underlying: string, now: Date): Promise<WatchRef | null> {
    const key = underlying.toUpperCase();
    const hit = this.refs.get(key);
    if (hit && now.getTime() - hit.at < 10 * MIN) return hit.ref;
    const ref = await this.market.underlyingRef(key, now).catch(() => null);
    this.refs.set(key, { ref, at: now.getTime() });
    return ref;
  }

  /** Wall clock for the bar cache (tests set it); `now` arguments stay the packet's own time. */
  clock: () => number = () => Date.now();
  private readonly barCache = new Map<string, { bars: Bar15m[]; validUntil: number; inflight: Promise<Bar15m[]> | null }>();

  /**
   * The underlying's 15m bars straight from Angel (the owner's historical API), ONE fetch shared by day(),
   * trend15m() and priceAt(), asked again only once a new 15m bar has closed and been published
   * (nextBarReadyAt). A finished bar never changes, so re-asking every 3-minute run only starved the shared
   * 350 ms historical gate (2026-11-27: 16 calls a run, every day/trend read timed out). While a refresh is in
   * flight the previous bars are served; a fetch slower than the packet's time box still lands in the cache.
   */
  private async loadBars(underlying: string): Promise<Bar15m[]> {
    const key = underlying.toUpperCase();
    const t = this.clock();
    const hit = this.barCache.get(key);
    if (hit && !hit.inflight && t < hit.validUntil) return hit.bars;
    if (hit?.inflight) return hit.bars.length ? hit.bars : hit.inflight;
    const ref = await this.ref(key, new Date(t));
    if (!ref) return [];
    // 1) Angel's live feed (the hub's tick bars): instant, outside the throttled historical gate — used only
    //    when it passes liveFeedGate. 2) Otherwise Angel's historical API, as before.
    const live = await this.liveFeedBars(ref, t).catch(() => null);
    if (live) {
      this.barCache.set(key, { bars: live, validUntil: nextBarReadyAt(t), inflight: null });
      return live;
    }
    const inflight = this.market
      .bars15m(ref, new Date(t - TREND_LOOKBACK_MS), new Date(t))
      .catch(() => [] as Bar15m[])
      .then((raw) => {
        const bars = [...(raw ?? [])].filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.close)).sort((a, b) => a.ts - b.ts);
        const fresh = bars.length > 0 ? { bars, validUntil: nextBarReadyAt(t) } : { bars: hit?.bars ?? [], validUntil: t + RETRY_EMPTY_MS };
        this.barCache.set(key, { ...fresh, inflight: null });
        return fresh.bars;
      });
    this.barCache.set(key, { bars: hit?.bars ?? [], validUntil: 0, inflight });
    return hit?.bars.length ? hit.bars : inflight;
  }

  /**
   * The underlying's 15m bars built from Angel's LIVE feed: the market hub writes every tick into 1-minute bars
   * (candles_1m), so this is the same Angel data with no historical-API call (2026-11-27: AB1021 "Too many
   * requests" app-wide starved the historical path). Session minutes only; null unless liveFeedGate passes.
   */
  private async liveFeedBars(ref: WatchRef, t: number): Promise<Bar15m[] | null> {
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

  private async bars(underlying: string, from: Date, now: Date): Promise<Bar15m[]> {
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
    const book = this.levelBooks.getLevels(ref.token);
    const today = await this.bars(underlying, istDayStart(now), now);
    const open = today.length ? today[0].open : null;
    const high = book?.todayHigh && book.todayHigh > 0 ? book.todayHigh : today.length ? Math.max(...today.map((b) => b.high)) : null;
    const low = book?.todayLow && book.todayLow > 0 ? book.todayLow : today.length ? Math.min(...today.map((b) => b.low)) : null;
    const vwap = book?.vwap && book.vwap > 0 ? book.vwap : null;
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
    const b = this.levelBooks.getLevels(ref.token);
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
