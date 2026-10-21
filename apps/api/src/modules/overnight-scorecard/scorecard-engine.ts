/**
 * Gathers each factor's inputs and runs the pure computers. Market-wide inputs (news window, VIX,
 * FII/DII, NIFTY mood) are read once per run; per-underlying inputs (chain, candles, setups) are
 * cached per underlying within the run. Every read is fail-soft: a failure makes that factor
 * `available:false`, never the whole scorecard.
 */
import { Logger } from '@nestjs/common';
import type { SessionClock } from '../market-hub/session-clock';
import type { MarketCuesSnapshot } from '../market-cues/market-cues.types';
import { daysToExpiry, lastSessionClose } from '../trade-sentinel/overnight/overnight-calendar';
import { articleKeys, heldNewsKeys, type NewsRow } from '../night-report/domain/night-report.logic';
import {
  scoreExpiry,
  scoreFiiDii,
  scoreIndicators,
  scoreMood,
  scoreNews,
  scoreOi,
  scoreVix,
  DAILY_MIN_BARS,
  type MoodInput,
} from './domain/factors';
import { betaTo } from './domain/indicators';
import type { DailyBar } from './domain/outcome';
import type { PositionShape } from './domain/positions';
import { assemble } from './domain/scoring';
import { applyTuning } from './domain/tuning';
import { DEFAULT_TUNING, type TuningReader } from '../self-review/tuning/tunables';
import { istYmd } from './domain/windows';
import type { BarBackfill, ChainReader } from './ports';
import type { ScorecardRepository } from './scorecard.repository';
import type { FactorScore, Scorecard, ScoreWindow } from './scorecard.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_BARS = 80;
const M15_BARS = 80;
const VIX_DAYS = 21;
/** A stored NIFTY prediction older than this is not used as the after-hours mood (covers a long weekend). */
export const STORED_MOOD_MAX_AGE_MS = 5 * DAY_MS;

export interface CuesSource {
  snapshot(now?: Date): MarketCuesSnapshot;
}
export interface MoodSource {
  behaviour(instrument: string): Promise<NonNullable<MoodInput['behaviour']>>;
}

export interface RunContext {
  now: Date;
  news: NewsRow[] | null;
  vix: number[] | null;
  cues: MarketCuesSnapshot | null;
  mood: MoodInput['behaviour'];
  perUnderlying: Map<string, Promise<UnderlyingData>>;
  /** NIFTY daily bars for stock betas, read once per run on first need. */
  niftyDaily?: Promise<DailyBar[] | null>;
}

interface UnderlyingData {
  chain: Awaited<ReturnType<ChainReader['latest']>>;
  history: Awaited<ReturnType<ChainReader['history']>>;
  chainFailed: boolean;
  dailyBars: DailyBar[] | null;
  daily: number[] | null;
  m15: number[] | null;
  setups: Array<{ setup: string; action: string }>;
}

const soft = async <T>(fn: () => Promise<T>, fallback: T): Promise<{ v: T; failed: boolean }> => {
  try {
    return { v: await fn(), failed: false };
  } catch {
    return { v: fallback, failed: true };
  }
};

export class ScorecardEngine {
  private readonly logger = new Logger('ScorecardEngine');
  /** Self-review overrides (factor weights, news confirmation). Default: none (every factor ×1). */
  private tuning: TuningReader = DEFAULT_TUNING;

  /** Bound by ScorecardService from the @Global TUNING_READER when the self-review module is loaded. */
  useTuning(tuning: TuningReader | null | undefined): void {
    this.tuning = tuning ?? DEFAULT_TUNING;
  }

  constructor(
    private readonly repo: ScorecardRepository,
    private readonly chains: ChainReader,
    private readonly cues: CuesSource | null,
    private readonly mood: MoodSource | null,
    private readonly clock: SessionClock,
    private readonly backfill: BarBackfill | null = null,
  ) {}

  /** The news window: the last 24 h after the close, else since the last NSE close (covers weekends). */
  newsFrom(window: ScoreWindow, now: Date): Date {
    const lastClose = lastSessionClose('NSE', now, this.clock);
    const dayAgo = new Date(now.getTime() - DAY_MS);
    if (window === 'OVERNIGHT' || !lastClose) return dayAgo;
    return lastClose < dayAgo ? lastClose : dayAgo;
  }

  async context(window: ScoreWindow, now: Date): Promise<RunContext> {
    const [news, vix, mood] = await Promise.all([
      soft(() => this.repo.newsBetween(this.newsFrom(window, now), now), null),
      soft(() => this.repo.vixCloses(VIX_DAYS), null),
      soft(async () => (this.mood ? await this.mood.behaviour('NIFTY') : null), null),
    ]);
    let cues: MarketCuesSnapshot | null = null;
    try {
      cues = this.cues ? this.cues.snapshot(now) : null;
    } catch {
      cues = null;
    }
    if (news.failed) this.logger.warn('[scorecard] news read failed; news factor unavailable this run');
    return { now, news: news.v, vix: vix.v, cues, mood: await this.moodOrStored(mood.v, now), perUnderlying: new Map() };
  }

  /**
   * The live MBM behaviour when it has horizons; else (the model only runs in session) the last
   * session's stored NIFTY predictions, flagged with their as-of so the factor labels them.
   */
  private async moodOrStored(live: MoodInput['behaviour'], now: Date): Promise<MoodInput['behaviour']> {
    if (live && live.status === 'ok' && live.horizons && Object.keys(live.horizons).length > 0) return live;
    const stored = await soft(() => this.repo.storedMood('NIFTY', now, STORED_MOOD_MAX_AGE_MS), null);
    if (!stored.v) return live;
    return { status: 'ok', horizons: stored.v.horizons, storedAsOf: stored.v.asOf };
  }

  /**
   * Bars of `timeframe` from `candles`; when fewer than the indicators need, one on-demand broker
   * backfill (persisted) and a re-read. A failed backfill leaves what was read (fail-soft).
   */
  private async bars(name: string, timeframe: '1d' | '15m', limit: number): Promise<DailyBar[] | null> {
    const read = () => this.repo.bars(name, timeframe, limit);
    const first = await read();
    if (!this.backfill || (first && first.length >= DAILY_MIN_BARS)) return first;
    try {
      if ((await this.backfill.fill(name, timeframe)) > 0) return await read();
    } catch (e) {
      this.logger.warn(`[scorecard] ${name} ${timeframe} backfill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return first;
  }

  private underlying(ctx: RunContext, name: string): Promise<UnderlyingData> {
    let p = ctx.perUnderlying.get(name);
    if (!p) {
      p = (async () => {
        const lastClose = lastSessionClose('NSE', ctx.now, this.clock);
        const [chain, history, daily, m15, setups] = await Promise.all([
          soft(() => this.chains.latest(name), null),
          soft(() => this.chains.history(name, 5), []),
          soft(() => this.bars(name, '1d', DAILY_BARS), null),
          soft(() => this.bars(name, '15m', M15_BARS), null),
          soft(() => (lastClose ? this.repo.dailySetups(name, istYmd(lastClose)) : Promise.resolve([])), []),
        ]);
        return {
          chain: chain.v,
          history: history.v,
          chainFailed: chain.failed,
          dailyBars: daily.v,
          daily: daily.v?.map((b) => b.close) ?? null,
          m15: m15.v?.map((b) => b.close) ?? null,
          setups: setups.v,
        };
      })();
      ctx.perUnderlying.set(name, p);
    }
    return p;
  }

  /** A stock long option's beta to NIFTY from the daily bars (null for indices, non-long-options, or too little data). */
  private async beta(ctx: RunContext, shape: PositionShape, u: UnderlyingData): Promise<number | null> {
    if (shape.isIndex || !shape.isLongOption || !u.dailyBars) return null;
    ctx.niftyDaily ??= soft(() => this.bars('NIFTY', '1d', DAILY_BARS), null).then((r) => r.v);
    const nifty = await ctx.niftyDaily;
    return nifty ? betaTo(u.dailyBars, nifty) : null;
  }

  articlesFor(ctx: RunContext, underlying: string, exchange: string): NewsRow[] | null {
    if (ctx.news == null) return null;
    const keys = heldNewsKeys({ label: underlying, exchange });
    if (keys.length === 0) return [];
    return ctx.news.filter((a) => {
      const ak = articleKeys(a);
      return keys.some((k) => ak.has(k));
    });
  }

  async score(
    ctx: RunContext,
    input: { userId: string | null; symbol: string; exchange: string; shape: PositionShape; window: ScoreWindow },
  ): Promise<Scorecard> {
    const { shape } = input;
    const side = shape.side;
    const u = await this.underlying(ctx, shape.underlying);
    const nextOpen = this.clock.nextOpen('NSE', ctx.now);
    const venue = input.exchange.toUpperCase() === 'BFO' ? 'BFO' : 'NFO';
    const factors: FactorScore[] = [
      scoreOi({ latest: u.chain, history: u.history }, side),
      scoreFiiDii({ fiiDii: ctx.cues?.fiiDii ?? null, fiiOi: ctx.cues?.fiiOi ?? null }, side),
      scoreVix({ closes: ctx.vix, isLongOption: shape.isLongOption, isIndex: shape.isIndex }, side),
      scoreExpiry({
        isOption: shape.isOption,
        isLongOption: shape.isLongOption,
        expiry: shape.expiry,
        dte: daysToExpiry(shape.expiry, venue, ctx.now, this.clock),
        gapDays: nextOpen ? (nextOpen.getTime() - ctx.now.getTime()) / DAY_MS : null,
      }),
      scoreNews(
        this.articlesFor(ctx, shape.underlying, input.exchange)?.map((a) => ({
          id: a.id, title: a.title, source: a.source, sentiment: a.sentiment, sentimentScore: a.sentimentScore, publishedAt: a.publishedAt,
        })) ?? null,
        side,
      ),
      scoreIndicators(
        {
          dailyCloses: u.daily,
          m15Closes: u.m15,
          setups: u.setups,
          isIndex: shape.isIndex,
          isLongCe: shape.isLongOption && shape.optionType === 'CE',
        },
        side,
      ),
      scoreMood({ behaviour: ctx.mood, isIndex: shape.isIndex, isLongOption: shape.isLongOption, beta: await this.beta(ctx, shape, u) }),
    ];
    return assemble({
      userId: input.userId,
      symbol: input.symbol,
      exchange: input.exchange,
      underlying: shape.underlying,
      side,
      window: input.window,
      computedAt: ctx.now,
      factors: this.tuned(factors),
    });
  }

  /** Fail-soft: a tuning read that throws leaves the factors untuned. */
  private tuned(factors: FactorScore[]): FactorScore[] {
    try {
      return applyTuning(factors, this.tuning);
    } catch (e) {
      this.logger.warn(`[scorecard] tuning skipped: ${e instanceof Error ? e.message : String(e)}`);
      return factors;
    }
  }
}
