import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TUNING_READER, type TuningReader } from '../self-review/tuning/tunables';
import { STOCK_MOVE_READER, type StockMoveReader } from '../stock-move/stock-move.service';
import { Cron } from '@nestjs/schedule';
import type { SessionClock } from '../market-hub/session-clock';
import { lastSessionClose } from '../trade-sentinel/overnight/overnight-calendar';
import { outcomeFor, OUTCOME_GIVE_UP_DAYS } from './domain/outcome';
import { isOvernightCandidate, shapeOf } from './domain/positions';
import { scorecardJobDue, type ScorecardJob } from './domain/windows';
import type { ScorecardEngine } from './scorecard-engine';
import { SCORECARD_CONFIG, type ScorecardConfig } from './scorecard.config';
import { ScorecardRepository } from './scorecard.repository';
import type { NewsIdea, Scorecard, ScoreWindow } from './scorecard.types';

export const SCORECARD_ENGINE = Symbol('SCORECARD_ENGINE');
export const SCORECARD_CLOCK = Symbol('SCORECARD_CLOCK');
export const SCORECARD_NOW = Symbol('SCORECARD_NOW');

const HOUR_MS = 60 * 60 * 1000;
/** A scorecard older than the last close minus this is not "the latest" for a position. */
const LATEST_GRACE_MS = 30 * 60 * 1000;
const POSITION_WINDOWS: ScoreWindow[] = ['OVERNIGHT', 'PRE_OPEN'];

export interface RunSummary {
  ran: boolean;
  stored: number;
  reason?: string;
}

/**
 * Overnight scorecards for the owner's real Angel positions (15:40 and 08:50 IST), the outcome
 * filler, and the read API used by the night report and (via stream C's ScorecardProvider token)
 * the sentinel. Deterministic: zero LLM calls.
 */
@Injectable()
export class ScorecardService {
  private readonly logger = new Logger(ScorecardService.name);
  private running = false;

  constructor(
    private readonly repo: ScorecardRepository,
    @Inject(SCORECARD_ENGINE) private readonly engine: ScorecardEngine,
    @Inject(SCORECARD_CONFIG) private readonly config: ScorecardConfig,
    @Inject(SCORECARD_CLOCK) private readonly clock: SessionClock,
    @Inject(SCORECARD_NOW) private readonly now: () => Date,
    /** Self-review overrides (@Global SelfReviewTuningModule); absent ⇒ untuned scorecards. */
    @Optional() @Inject(TUNING_READER) tuning?: TuningReader,
    /** The stock big-move book (@Global StockMoveModule); absent ⇒ stock lines read "no stock-move score yet". */
    @Optional() @Inject(STOCK_MOVE_READER) stockMove?: StockMoveReader,
  ) {
    this.engine.useTuning?.(tuning);
    this.engine.useStockMove?.(stockMove);
  }

  @Cron('0 40 15 * * 1-5', { name: 'scorecard-overnight', timeZone: 'Asia/Kolkata' })
  onOvernight(): Promise<RunSummary> {
    return this.run('OVERNIGHT');
  }

  @Cron('0 50 8 * * 1-5', { name: 'scorecard-pre-open', timeZone: 'Asia/Kolkata' })
  onPreOpen(): Promise<RunSummary> {
    return this.run('PRE_OPEN');
  }

  @Cron('0 30 18 * * 1-5', { name: 'scorecard-outcomes', timeZone: 'Asia/Kolkata' })
  async onOutcomes(): Promise<number> {
    if (this.config.mode === 'off') return 0;
    try {
      return await this.fillOutcomes(this.now());
    } catch (e) {
      this.logger.warn(`[scorecard] outcome filler failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  async run(job: ScorecardJob, now: Date = this.now()): Promise<RunSummary> {
    if (this.config.mode === 'off') return { ran: false, stored: 0, reason: 'SCORECARD_ENABLED=off' };
    const userId = this.config.ownerUserId;
    if (!userId) return { ran: false, stored: 0, reason: 'no owner user id' };
    if (!scorecardJobDue(job, now, this.clock)) return { ran: false, stored: 0, reason: 'not an NSE session window' };
    if (this.running) return { ran: false, stored: 0, reason: 'previous run still going' };
    this.running = true;
    try {
      const trackers = (await this.repo.openTrackers(userId)).filter(isOvernightCandidate);
      if (trackers.length === 0) return { ran: true, stored: 0 };
      const ctx = await this.engine.context(job, now);
      let stored = 0;
      for (const t of trackers) {
        try {
          const sc = await this.engine.score(ctx, {
            userId, symbol: t.symbol, exchange: t.exchange, shape: shapeOf(t.symbol, t.exchange, t.qty), window: job,
          });
          await this.repo.insertScorecard(sc);
          stored++;
        } catch (e) {
          this.logger.warn(`[scorecard] ${job} ${t.symbol} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.logger.log(`[scorecard] ${job}: ${stored}/${trackers.length} scorecards stored (mode=${this.config.mode})`);
      return { ran: true, stored };
    } catch (e) {
      this.logger.warn(`[scorecard] ${job} run failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: true, stored: 0, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running = false;
    }
  }

  /** Fill outcome columns of rows computed in the last OUTCOME_GIVE_UP_DAYS whose next session has closed. */
  async fillOutcomes(now: Date): Promise<number> {
    const targets = await this.repo.unfilled(new Date(now.getTime() - OUTCOME_GIVE_UP_DAYS * 24 * HOUR_MS), new Date(now.getTime() - 6 * HOUR_MS));
    const bars = new Map<string, Awaited<ReturnType<ScorecardRepository['bars']>>>();
    let filled = 0;
    for (const t of targets) {
      if (!bars.has(t.underlying)) bars.set(t.underlying, await this.repo.bars(t.underlying, '1d', 15).catch(() => null));
      const o = outcomeFor(t.at, bars.get(t.underlying) ?? [], now, this.clock);
      if (!o) continue;
      await this.repo.fill(t, o, now);
      filled++;
    }
    if (filled) this.logger.log(`[scorecard] outcomes filled: ${filled}/${targets.length}`);
    return filled;
  }

  // ─── Read API ──────────────────────────────────────────────────────────────

  private since(now: Date): Date {
    const close = lastSessionClose('NSE', now, this.clock);
    return new Date((close ?? new Date(now.getTime() - 24 * HOUR_MS)).getTime() - LATEST_GRACE_MS);
  }

  /**
   * The newest scorecard for a position (by tracker id) or a symbol, in `window` (default: the
   * newest of OVERNIGHT / PRE_OPEN), computed since the last NSE close. Null when none.
   */
  async latestFor(
    userId: string,
    target: { trackerId: string } | { symbol: string; exchange?: string },
    window?: ScoreWindow,
    now: Date = this.now(),
  ): Promise<Scorecard | null> {
    const windows = window ? [window] : POSITION_WINDOWS;
    if ('trackerId' in target) {
      const t = await this.repo.tracker(userId, target.trackerId);
      if (!t) return null;
      return this.repo.latestScorecard(userId, t.symbol, t.exchange, windows, this.since(now));
    }
    if (target.exchange) return this.repo.latestScorecard(userId, target.symbol, target.exchange, windows, this.since(now));
    return this.repo.latestBySymbol(target.symbol, windows, this.since(now));
  }

  /**
   * Stream C's `ScorecardProvider.latest`: what the sentinel's overnight/pre-open packet reads.
   * Only with SCORECARD_ENABLED=on (observe stores and shows, but never feeds the judge). Never throws.
   */
  async latest(userId: string, trackerId: string): Promise<Scorecard | null> {
    if (this.config.mode !== 'on') return null;
    try {
      return await this.latestFor(userId, { trackerId });
    } catch (e) {
      this.logger.warn(`[scorecard] latest(${trackerId}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Night report: the latest scorecard per tracker (missing ⇒ absent from the map). */
  async forTrackers(userId: string, trackers: ReadonlyArray<{ id: string; symbol: string; exchange: string }>, now: Date): Promise<Map<string, Scorecard>> {
    const out = new Map<string, Scorecard>();
    const since = this.since(now);
    for (const t of trackers) {
      const sc = await this.repo.latestScorecard(userId, t.symbol, t.exchange, POSITION_WINDOWS, since);
      if (sc) out.set(t.id, sc);
    }
    return out;
  }

  /** Night report: ideas created since `since`, newest first, with their scorecard, outcome and headline url. */
  async newsIdeasSince(since: Date): Promise<NewsIdeaView[]> {
    const ideas = await this.repo.ideasSince(since);
    if (ideas.length === 0) return [];
    const [scs, urls] = await Promise.all([
      this.repo.scorecardsByIds(ideas.map((i) => i.scorecardId).filter((x): x is string => !!x)),
      this.repo.articleUrls(ideas.map((i) => i.newsIds[0]).filter((x): x is string => !!x)),
    ]);
    return ideas.map((i) => ({
      ...i,
      scorecard: i.scorecardId ? scs.get(i.scorecardId) ?? null : null,
      url: i.newsIds[0] ? urls.get(i.newsIds[0]) ?? null : null,
    }));
  }
}

/** One `newsIdeas` item of GET /api/night-report (see the night-report contract doc). */
export type NewsIdeaView = NewsIdea & {
  scorecard: Scorecard | null;
  nextOpen: number | null;
  nextClose: number | null;
  moveBp: number | null;
  filledAt: string | null;
  /** The headline article's url (from the first news id); null when unknown. */
  url: string | null;
};
