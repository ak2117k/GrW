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
  type MoodInput,
} from './domain/factors';
import type { PositionShape } from './domain/positions';
import { assemble } from './domain/scoring';
import { istYmd } from './domain/windows';
import type { ChainReader } from './ports';
import type { ScorecardRepository } from './scorecard.repository';
import type { FactorScore, Scorecard, ScoreWindow } from './scorecard.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_BARS = 80;
const M15_BARS = 80;
const VIX_DAYS = 21;

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
}

interface UnderlyingData {
  chain: Awaited<ReturnType<ChainReader['latest']>>;
  history: Awaited<ReturnType<ChainReader['history']>>;
  chainFailed: boolean;
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

  constructor(
    private readonly repo: ScorecardRepository,
    private readonly chains: ChainReader,
    private readonly cues: CuesSource | null,
    private readonly mood: MoodSource | null,
    private readonly clock: SessionClock,
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
    return { now, news: news.v, vix: vix.v, cues, mood: mood.v, perUnderlying: new Map() };
  }

  private underlying(ctx: RunContext, name: string): Promise<UnderlyingData> {
    let p = ctx.perUnderlying.get(name);
    if (!p) {
      p = (async () => {
        const lastClose = lastSessionClose('NSE', ctx.now, this.clock);
        const [chain, history, daily, m15, setups] = await Promise.all([
          soft(() => this.chains.latest(name), null),
          soft(() => this.chains.history(name, 5), []),
          soft(async () => (await this.repo.bars(name, '1d', DAILY_BARS))?.map((b) => b.close) ?? null, null),
          soft(async () => (await this.repo.bars(name, '15m', M15_BARS))?.map((b) => b.close) ?? null, null),
          soft(() => (lastClose ? this.repo.dailySetups(name, istYmd(lastClose)) : Promise.resolve([])), []),
        ]);
        return {
          chain: chain.v,
          history: history.v,
          chainFailed: chain.failed,
          daily: daily.v,
          m15: m15.v,
          setups: setups.v,
        };
      })();
      ctx.perUnderlying.set(name, p);
    }
    return p;
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
      scoreIndicators({ dailyCloses: u.daily, m15Closes: u.m15, setups: u.setups }, side),
      scoreMood({ behaviour: ctx.mood, isIndex: shape.isIndex, isLongOption: shape.isLongOption }),
    ];
    return assemble({
      userId: input.userId,
      symbol: input.symbol,
      exchange: input.exchange,
      underlying: shape.underlying,
      side,
      window: input.window,
      computedAt: ctx.now,
      factors,
    });
  }
}
