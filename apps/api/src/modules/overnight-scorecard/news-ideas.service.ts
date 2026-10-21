import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { MessagesTransport, TransportMessage } from '../ai-gateway/transport.types';
import { withAiCallContext } from '../ai-gateway/audit/ai-call-context';
import type { SessionClock } from '../market-hub/session-clock';
import { underlyingName } from '../night-report/domain/night-report.logic';
import { lastSessionClose } from '../trade-sentinel/overnight/overnight-calendar';
import {
  buildNewsIdeasUserMessage,
  extractJsonText,
  NEWS_IDEAS_SCHEMA,
  newsIdeasSystemPrompt,
  validateIdeas,
} from './domain/news-ideas-ai';
import { shapeOf } from './domain/positions';
import { shortlist, type Candidate } from './domain/shortlist';
import { newsBatchDue, istYmd, type NewsBatch } from './domain/windows';
import { baseSymbol } from '../news-events/keys';
import { SCORECARD_CHAIN_CAPTURE, SCORECARD_LLM, SCORECARD_WATCHLIST, type ChainCapturer, type WatchlistWriter } from './ports';
import type { ScorecardEngine } from './scorecard-engine';
import { SCORECARD_CONFIG, type ScorecardConfig } from './scorecard.config';
import { ScorecardRepository } from './scorecard.repository';
import { SCORECARD_CLOCK, SCORECARD_ENGINE, SCORECARD_NOW } from './scorecard.service';
import type { Scorecard } from './scorecard.types';
import { LESSONS_READER, type InjectedLesson, type LessonsReader } from '../self-review/lessons/types';

const MAX_TOKENS = 4000;
/** The `ai_calls.job` label of the news-ideas batch call. */
export const NEWS_IDEAS_JOB = 'news.ideas';
/** How long a news symbol stays on stream A's chain-capture watchlist. */
export const WATCHLIST_TTL_HOURS = 36;

export interface BatchSummary {
  ran: boolean;
  candidates: number;
  stored: number;
  reason?: string;
}

/**
 * News ideas (design §4): twice a night, shortlist F&O stocks with strong news that the owner does
 * not hold (cap 5), score each the same way as a position, register them for chain capture, and
 * make ONE Sonnet call for the whole batch. Strict JSON or nothing is stored. Ideas only: this
 * service places nothing and creates no paper trade.
 */
@Injectable()
export class NewsIdeasService {
  private readonly logger = new Logger(NewsIdeasService.name);
  private running = false;

  constructor(
    private readonly repo: ScorecardRepository,
    @Inject(SCORECARD_ENGINE) private readonly engine: ScorecardEngine,
    @Inject(SCORECARD_CONFIG) private readonly config: ScorecardConfig,
    @Inject(SCORECARD_CLOCK) private readonly clock: SessionClock,
    @Inject(SCORECARD_NOW) private readonly now: () => Date,
    @Inject(SCORECARD_LLM) private readonly llm: MessagesTransport,
    @Inject(SCORECARD_WATCHLIST) private readonly watchlist: WatchlistWriter,
    @Optional() @Inject(SCORECARD_CHAIN_CAPTURE) private readonly chainCapture: ChainCapturer | null = null,
    /** Self-review lessons (scope NEWS_IDEAS), from an in-memory cache. Absent ⇒ none. */
    @Optional() @Inject(LESSONS_READER) private readonly lessons: LessonsReader | null = null,
  ) {}

  /** The lessons for this batch's prompt; [] when off/observe/unwired. Never throws. */
  private batchLessons(): InjectedLesson[] {
    try {
      return this.lessons?.inject('NEWS_IDEAS') ?? [];
    } catch {
      return [];
    }
  }

  @Cron('0 30 23 * * *', { name: 'news-ideas-night', timeZone: 'Asia/Kolkata' })
  onNight(): Promise<BatchSummary> {
    return this.run('NIGHT');
  }

  @Cron('0 40 8 * * 1-5', { name: 'news-ideas-morning', timeZone: 'Asia/Kolkata' })
  onMorning(): Promise<BatchSummary> {
    return this.run('MORNING');
  }

  async run(batch: NewsBatch, now: Date = this.now()): Promise<BatchSummary> {
    const none = (reason: string): BatchSummary => ({ ran: false, candidates: 0, stored: 0, reason });
    if (!this.config.newsIdeas) return none('NEWS_IDEAS_ENABLED=off');
    if (!newsBatchDue(batch, now, this.clock)) return none('no NSE session next');
    if (this.running) return none('previous batch still going');
    this.running = true;
    try {
      return await this.batch(batch, now);
    } catch (e) {
      this.logger.warn(`[news-ideas] ${batch} batch failed, nothing stored: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: true, candidates: 0, stored: 0, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running = false;
    }
  }

  private async batch(batch: NewsBatch, now: Date): Promise<BatchSummary> {
    const from = lastSessionClose('NSE', now, this.clock) ?? new Date(now.getTime() - 24 * 3600_000);
    const [articles, fno, held, already] = await Promise.all([
      this.repo.newsBetween(from, now),
      this.repo.fnoNames(istYmd(now)),
      this.heldUnderlyings(),
      this.repo.ideaNewsIdsSince(from),
    ]);
    const candidates = shortlist(
      articles.map((a) => ({
        id: a.id, title: a.title, url: a.url, source: a.source, sentiment: a.sentiment, sentimentScore: a.sentimentScore,
        publishedAt: a.publishedAt, instruments: [...(a.instruments ?? []), ...(a.relatedSymbols ?? []).map(baseSymbol)],
      })),
      fno,
      held,
      already,
    );
    if (candidates.length === 0) return { ran: true, candidates: 0, stored: 0 };

    // Fresh chains for the (F&O) candidates first, so their OI factor has a snapshot to read: they
    // are usually not on the capture watchlist yet. Best effort; a failure leaves OI unavailable.
    if (this.chainCapture) {
      try {
        await this.chainCapture.captureFor(candidates.map((c) => c.symbol));
      } catch (e) {
        this.logger.warn(`[news-ideas] candidate chain capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const ctx = await this.engine.context('NEWS_IDEA', now);
    const scored: Array<{ candidate: Candidate; scorecard: Scorecard }> = [];
    for (const c of candidates) {
      const side = c.strength >= 0 ? 'BULLISH' : 'BEARISH';
      // A notional at-the-money long option on the news's side: scores expiry/VIX as a buyer would face them.
      const shape = { ...shapeOf(c.symbol, c.exchange, 1), side, isLongOption: true, isOption: false } as const;
      scored.push({ candidate: c, scorecard: await this.engine.score(ctx, { userId: null, symbol: c.symbol, exchange: c.exchange, shape, window: 'NEWS_IDEA' }) });
    }

    // Stream A captures these symbols' chains from now on (best effort; never blocks the batch).
    await this.watchlist.add(candidates.map((c) => ({ symbol: c.symbol, exchange: c.exchange })), WATCHLIST_TTL_HOURS).catch((e: unknown) =>
      this.logger.warn(`[news-ideas] watchlist add failed: ${e instanceof Error ? e.message : String(e)}`),
    );

    const lessons = this.batchLessons();
    let reply: TransportMessage;
    try {
      // The owner is who the batch is for; it has no position. Recorded on the `ai_calls` row.
      reply = await withAiCallContext({ userId: this.config.ownerUserId ?? undefined }, () =>
        this.llm.messages.create({
          model: this.config.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: NEWS_IDEAS_SCHEMA as unknown as Record<string, unknown> } },
          system: [{ type: 'text', text: newsIdeasSystemPrompt(lessons.length > 0), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: buildNewsIdeasUserMessage(scored, lessons) }],
        }),
      );
    } catch (e) {
      throw new Error(`Sonnet call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const ideas = validateIdeas(extractJsonText(text), candidates.map((c) => c.symbol));
    const bySymbol = new Map(scored.map((s) => [s.candidate.symbol, s]));
    const stored = await this.repo.insertIdeas(
      ideas.map((i) => {
        const s = bySymbol.get(i.symbol)!;
        return {
          scorecard: s.scorecard,
          idea: {
            symbol: i.symbol, exchange: s.candidate.exchange, newsIds: s.candidate.newsIds, headline: s.candidate.headline,
            idea: i.idea, rationale: i.rationale, invalidation: i.invalidation, whatToDo: i.whatToDo,
          },
        };
      }),
      null,
    );
    this.logger.log(`[news-ideas] ${batch}: ${stored} ideas stored from ${candidates.length} candidates`);
    return { ran: true, candidates: candidates.length, stored };
  }

  private async heldUnderlyings(): Promise<Set<string>> {
    const userId = this.config.ownerUserId;
    if (!userId) return new Set();
    const trackers = await this.repo.openTrackers(userId);
    return new Set(trackers.map((t) => underlyingName(t.symbol, t.exchange) ?? baseSymbol(t.symbol)));
  }
}
