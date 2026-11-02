import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrokerOverviewService } from '../../credential-vault/services/broker-overview.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { baseSym, ideaScore, screenFailures, type ScreenCandidate } from '../domain/action-plan';
import { EVIDENCE_RULES, OI_NOT_FNO, OI_NO_DATA, buildEvidence, materialNews, oiEvidence } from '../domain/evidence';
import { type DailyBar, trendFromBars } from '../domain/holdings';
import { istDay } from '../domain/symbols';
import type { BalanceRead, Evidence, HoldingCheck, OiEvidence, ScreenStats } from '../domain/types';
import { INDEX_FUTURE_NAME, PlanDataRepository, type FutureLine } from '../repositories/plan-data.repository';

/** Hard cap on broker calls (candles + OI + funds) per review run. */
export const MAX_BROKER_CALLS_PER_RUN = 110;
/** Spacing between this module's historical reads (the session also paces them, ~350 ms). */
export const CANDLE_SPACING_MS = 400;
/** Time the run may spend on holdings candles + OI before the rest are NO_DATA. */
export const HOLDINGS_BUDGET_MS = 90_000;
/** Time the run may spend on the new-idea screen. */
export const SCREEN_BUDGET_MS = 90_000;
/** The screen looks at the most liquid this many F&O stocks (futures turnover from the OI capture) … */
export const SCREEN_POOL = 80;
/** … fetching daily candles for at most this many not already cached today … */
export const SCREEN_MAX_CANDLE_FETCHES = 40;
/** … and futures OI for at most this many that pass the trend rules. */
export const SCREEN_MAX_OI_FETCHES = 10;
/** Futures OI window read from the broker (calendar days). */
export const OI_LOOKBACK_DAYS = 35;
/** A last-known margin snapshot older than this is not used. */
export const MARGIN_MAX_AGE_MS = 7 * 86_400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istYmd = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Counts broker calls against the per-run cap. */
export class BrokerBudget {
  used = 0;
  constructor(readonly cap: number = MAX_BROKER_CALLS_PER_RUN) {}
  take(): boolean {
    if (this.used >= this.cap) return false;
    this.used++;
    return true;
  }
  get left(): number {
    return this.cap - this.used;
  }
}

export interface HoldingsEvidence {
  trends: Map<string, ReturnType<typeof trendFromBars>>;
  evidence: Map<string, Evidence>;
  notes: string[];
}

/**
 * Market evidence for the action plan, read over the caller's OWN broker session (quotes / history /
 * funds only — never an order) within MAX_BROKER_CALLS_PER_RUN and the time boxes, plus DB reads
 * (news, events, sectors, the OI capture). Daily candles are market data, so they are cached per
 * token per IST day across runs and users. Every source fails open into NO_DATA with a note.
 */
@Injectable()
export class PlanDataService {
  private readonly logger = new Logger(PlanDataService.name);
  private readonly barsCache = new Map<string, { day: string; bars: DailyBar[] }>();
  /** Overridable in tests. */
  spacingMs = CANDLE_SPACING_MS;

  constructor(
    private readonly repo: PlanDataRepository,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() private readonly overview?: BrokerOverviewService,
  ) {}

  /** Available cash: the broker's RMS (one call) → the last stored margin snapshot (≤ 7 days) → NO_DATA. */
  async balance(userId: string, budget: BrokerBudget, now: Date): Promise<BalanceRead> {
    let reason = 'no broker funds reader wired';
    if (this.overview && budget.take()) {
      try {
        const f = await this.overview.getFunds(userId);
        if (f && Number.isFinite(f.availableCash)) return { status: 'LIVE', availableCash: f.availableCash, asOf: now.toISOString() };
        reason = 'the broker did not return available cash';
      } catch (e) {
        reason = errText(e).slice(0, 120);
      }
    }
    try {
      const last = await this.repo.latestMargin(userId);
      if (last && now.getTime() - last.asOf.getTime() <= MARGIN_MAX_AGE_MS) {
        return { status: 'LAST_KNOWN', availableCash: last.availableCash, asOf: last.asOf.toISOString(), reason };
      }
    } catch {
      // fall through
    }
    return { status: 'NO_DATA', availableCash: null, asOf: null, reason };
  }

  /** ~1 year of daily candles, cached per token per IST day. Null when not fetched (budget / no session / error). */
  async dailyBars(userId: string, token: string, exchange: string, budget: BrokerBudget, now: Date, state: { first: boolean }): Promise<{ bars: DailyBar[] | null; cached: boolean; error?: string }> {
    const key = `${exchange}:${token}`;
    const today = istDay(now);
    const hit = this.barsCache.get(key);
    if (hit && hit.day === today) return { bars: hit.bars, cached: true };
    if (!this.feeds) return { bars: null, cached: false, error: 'no broker session wired' };
    if (!budget.take()) return { bars: null, cached: false, error: 'broker-call cap for this run used up' };
    if (!state.first) await sleep(this.spacingMs);
    state.first = false;
    try {
      const raw = await this.feeds.fetchCandles(userId, token, exchange, '1d', new Date(now.getTime() - 370 * 86_400_000), now);
      const bars = (raw ?? []).map((b) => ({ close: Number(b.close), high: Number(b.high), low: Number(b.low), date: istYmd(new Date(b.timestamp as unknown as string)) }));
      if (bars.length >= 20) this.barsCache.set(key, { day: today, bars });
      return { bars, cached: false };
    } catch (e) {
      return { bars: null, cached: false, error: errText(e).slice(0, 120) };
    }
  }

  /**
   * Futures OI evidence for one underlying: the broker's daily OI of the nearest future (one call)
   * joined to the stock's daily closes; else the app's own 3-minute OI capture (oi_snapshots).
   */
  async futuresOi(userId: string, fut: FutureLine | undefined, bars: DailyBar[] | null, budget: BrokerBudget, now: Date, state: { first: boolean }): Promise<OiEvidence> {
    if (!fut) return OI_NOT_FNO;
    let reason = 'no broker session wired';
    if (this.feeds && bars?.length && budget.left > 0) {
      budget.take();
      if (!state.first) await sleep(this.spacingMs);
      state.first = false;
      try {
        const oi = await this.feeds.fetchOIWindow(userId, { token: fut.token, exchange: 'NFO' }, 'ONE_DAY', new Date(now.getTime() - OI_LOOKBACK_DAYS * 86_400_000), now);
        const oiByDay = new Map((oi ?? []).map((p) => [istYmd(new Date(p.ts)), Number(p.oi)]));
        const pts = bars.filter((b) => b.date && oiByDay.has(b.date)).map((b) => ({ date: b.date as string, close: b.close, oi: oiByDay.get(b.date as string) as number }));
        const ev = oiEvidence(pts, 'BROKER');
        if (ev.status !== 'NO_DATA') return ev;
        reason = ev.reason ?? 'no OI rows';
      } catch (e) {
        reason = errText(e).slice(0, 120);
      }
    } else if (budget.left <= 0) reason = 'broker-call cap for this run used up';
    try {
      const snap = oiEvidence(await this.repo.futuresOiDaily(fut.instrumentId, now), 'SNAPSHOTS');
      if (snap.status !== 'NO_DATA') return snap;
      return OI_NO_DATA(`broker: ${reason}; capture: ${snap.reason}`, 'SNAPSHOTS');
    } catch (e) {
      return OI_NO_DATA(`broker: ${reason}; capture: ${errText(e).slice(0, 80)}`);
    }
  }

  /** Trend + OI + news + events + sector per open holding (cash equities). */
  async holdingsEvidence(userId: string, holdings: HoldingCheck[], budget: BrokerBudget, now: Date, onProgress?: (t: string) => void): Promise<HoldingsEvidence> {
    const notes: string[] = [];
    const trends = new Map<string, ReturnType<typeof trendFromBars>>();
    const evidence = new Map<string, Evidence>();
    const symbols = [...new Set(holdings.map((h) => baseSym(h.symbol)))];
    const [futures, news, events, sectors] = await Promise.all([
      this.repo.futuresByName(now).catch(() => new Map<string, FutureLine>()),
      this.repo.newsFor(symbols, new Date(now.getTime() - EVIDENCE_RULES.newsDays * 86_400_000)).catch(() => new Map()),
      this.repo.eventsFor(symbols, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + EVIDENCE_RULES.eventDays * 86_400_000)).catch(() => new Map()),
      this.repo.sectors(symbols).catch(() => new Map<string, string>()),
    ]);
    const started = Date.now();
    const state = { first: true };
    let i = 0;
    for (const h of holdings) {
      i++;
      onProgress?.(`Reading prices and OI for your holdings (${i}/${holdings.length})`);
      const sym = baseSym(h.symbol);
      const late = Date.now() - started > HOLDINGS_BUDGET_MS;
      const got = late ? { bars: null, cached: false, error: 'holdings time budget used up' } : await this.dailyBars(userId, h.token, h.exchange, budget, now, state);
      const trend = got.bars ? trendFromBars(got.bars) : { status: 'NO_DATA' as const, reason: got.error ?? 'no candles', bars: 0, dma50: null, dma200: null, high52w: null, low52w: null, ret6m: null };
      trends.set(h.token, trend);
      const fut = futures.get(sym);
      const oi = late && fut ? OI_NO_DATA('holdings time budget used up') : await this.futuresOi(userId, fut, got.bars as DailyBar[] | null, budget, now, state);
      evidence.set(
        h.token,
        buildEvidence({ trend, price: h.ltp, news: materialNews(news.get(sym) ?? [], now), oi, events: events.get(sym) ?? [], sector: sectors.get(sym) ?? null }),
      );
    }
    const noTrend = [...trends.values()].filter((t) => t.status !== 'OK').length;
    if (noTrend) notes.push(`${noTrend} holding(s) have no daily-candle trend this run (broker history unavailable or the run's broker-call cap was reached) — they get HOLD / SET_STOP only.`);
    const fno = holdings.filter((h) => futures.has(baseSym(h.symbol))).length;
    const oiOk = [...evidence.values()].filter((e) => e.oi.status !== 'NOT_FNO' && e.oi.status !== 'NO_DATA').length;
    if (fno) notes.push(`${fno} holding(s) are F&O stocks; futures OI read for ${oiOk}.`);
    return { trends, evidence, notes };
  }

  /**
   * The new-idea screen over the F&O stock universe, cheap by construction: the SCREEN_POOL most liquid
   * names (futures turnover from the app's OI capture), daily candles for at most
   * SCREEN_MAX_CANDLE_FETCHES not cached today, the trend rules first, then futures OI for at most
   * SCREEN_MAX_OI_FETCHES of the passers. Held symbols are skipped.
   */
  async screen(userId: string, held: Set<string>, budget: BrokerBudget, now: Date, onProgress?: (t: string) => void): Promise<{ candidates: ScreenCandidate[]; stats: Omit<ScreenStats, 'picked'> }> {
    const stats: Omit<ScreenStats, 'picked'> = { universe: 0, fetched: 0, cachedToday: 0, passedTrend: 0, oiChecked: 0, skippedReason: null };
    let futures: Map<string, FutureLine>;
    try {
      futures = await this.repo.futuresByName(now);
    } catch (e) {
      return { candidates: [], stats: { ...stats, skippedReason: `F&O universe unavailable: ${errText(e).slice(0, 80)}` } };
    }
    const stocks = [...futures.values()].filter((f) => !INDEX_FUTURE_NAME.test(f.name));
    stats.universe = stocks.length;
    if (!stocks.length) return { candidates: [], stats: { ...stats, skippedReason: 'no live F&O stock futures in the instrument master' } };
    if (!this.feeds) return { candidates: [], stats: { ...stats, skippedReason: 'no broker session wired' } };

    const [turnover, cash] = await Promise.all([
      this.repo.futuresTurnover(stocks.map((s) => s.instrumentId), now).catch(() => new Map<string, number>()),
      this.repo.cashLines(stocks.map((s) => s.name)).catch(() => new Map<string, string>()),
    ]);
    const pool = stocks
      .filter((s) => !held.has(s.name) && cash.has(s.name))
      .sort((a, b) => (turnover.get(b.instrumentId) ?? 0) - (turnover.get(a.instrumentId) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, SCREEN_POOL);
    const names = pool.map((p) => p.name);
    const [news, events, sectors] = await Promise.all([
      this.repo.newsFor(names, new Date(now.getTime() - EVIDENCE_RULES.newsDays * 86_400_000)).catch(() => new Map()),
      this.repo.eventsFor(names, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + EVIDENCE_RULES.eventDays * 86_400_000)).catch(() => new Map()),
      this.repo.sectors(names).catch(() => new Map<string, string>()),
    ]);

    const started = Date.now();
    const state = { first: true };
    const withBars: Array<{ f: FutureLine; token: string; bars: DailyBar[]; e: Evidence }> = [];
    let fetched = 0;
    for (const f of pool) {
      if (Date.now() - started > SCREEN_BUDGET_MS) {
        stats.skippedReason = 'screen time budget used up — the rest of the pool was not checked';
        break;
      }
      const token = cash.get(f.name) as string;
      const cachedOnly = fetched >= SCREEN_MAX_CANDLE_FETCHES || budget.left <= SCREEN_MAX_OI_FETCHES;
      const key = `NSE:${token}`;
      const hit = this.barsCache.get(key);
      if (cachedOnly && !(hit && hit.day === istDay(now))) continue;
      onProgress?.(`Screening liquid F&O stocks (${withBars.length + 1} checked)`);
      const got = await this.dailyBars(userId, token, 'NSE', budget, now, state);
      if (got.cached) stats.cachedToday++;
      else if (got.bars) {
        fetched++;
        stats.fetched++;
      } else {
        fetched++;
        continue;
      }
      if (!got.bars) continue;
      const trend = trendFromBars(got.bars);
      const e = buildEvidence({ trend, price: null, news: materialNews(news.get(f.name) ?? [], now), oi: OI_NO_DATA('not read yet'), events: events.get(f.name) ?? [], sector: sectors.get(f.name) ?? null });
      withBars.push({ f, token, bars: got.bars as DailyBar[], e });
    }

    const passers = withBars.filter((x) => screenFailures(x.e, now, { ignoreOi: true }).length === 0).sort((a, b) => ideaScore(b.e, false) - ideaScore(a.e, false));
    stats.passedTrend = passers.length;
    const candidates: ScreenCandidate[] = [];
    for (const p of passers.slice(0, SCREEN_MAX_OI_FETCHES)) {
      onProgress?.(`Checking futures OI for screen passers (${stats.oiChecked + 1}/${Math.min(passers.length, SCREEN_MAX_OI_FETCHES)})`);
      const oi = await this.futuresOi(userId, p.f, p.bars, budget, now, state);
      if (oi.status !== 'NO_DATA') stats.oiChecked++;
      candidates.push({ symbol: p.f.name, exchange: 'NSE', token: p.token, evidence: { ...p.e, oi } });
    }
    if (!stats.skippedReason && fetched >= SCREEN_MAX_CANDLE_FETCHES) stats.skippedReason = `candle fetches capped at ${SCREEN_MAX_CANDLE_FETCHES} this run (cached names still checked)`;
    this.logger.log(`[portfolio-review] screen ${userId}: pool ${pool.length}, fetched ${stats.fetched}, cached ${stats.cachedToday}, passed ${stats.passedTrend}, oi ${stats.oiChecked}, broker calls ${budget.used}/${budget.cap}`);
    return { candidates, stats };
  }
}
