import { Injectable, Logger, Optional } from '@nestjs/common';
import { AssistLlmService, type AssistJob, type AssistPrincipal } from '../../ai-assist/assist-llm.service';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { LiveTradesRepository } from '../../portfolio/repositories/live-trades.repository';
import { NO_TREND, trendFromBars } from '../domain/holdings';
import { buildPortfolioReview } from '../domain/report';
import { PORTFOLIO_REVIEW_SYSTEM_PROMPT, acceptSummary, summaryUserTurn } from '../domain/summary-prompt';
import { istDay } from '../domain/symbols';
import type { ExitInput, HoldingTrend, LlmSummary, OrderInput, PortfolioReview, TrackerInput } from '../domain/types';
import { PortfolioReviewRepository, type ReviewHistoryRow } from '../repositories/portfolio-review.repository';

export const REVIEW_CACHE_MS = 15 * 60_000;
/** A forced refresh at most this often per user (it re-reads the book and may spend a model call). */
export const REFRESH_MIN_GAP_MS = 60_000;
/** Spacing between daily-candle reads (the broker's historical endpoint is rate-limited). */
export const CANDLE_SPACING_MS = 400;
/** Total time the request may spend on holdings candles before the rest are NO_DATA. */
export const CANDLE_BUDGET_MS = 60_000;
/** How long the request waits for the LLM summary before returning it as PENDING. */
export const SUMMARY_WAIT_MS = 45_000;
/** `ai_calls.job` label. Not in ai-assist's AssistJob union (this module does not edit ai-assist). */
const SUMMARY_JOB = 'portfolio.review' as unknown as AssistJob;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface CacheEntry {
  at: number;
  id: string | null;
  review: PortfolioReview;
}

/**
 * Portfolio review: reads the caller's real broker book, computes the
 * deterministic review (domain/*), adds a daily-candle trend per holding over
 * the caller's OWN broker session, and — for the owner only, through the
 * advisor's Claude door — a plain-language summary. Fails open: no feed → trend
 * NO_DATA; no model / busy / error → the report without the summary text.
 * Read-only on everything except its own portfolio_reviews table.
 */
@Injectable()
export class PortfolioReviewService {
  private readonly logger = new Logger(PortfolioReviewService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PortfolioReview>>();
  private readonly trendCache = new Map<string, { day: string; trend: HoldingTrend }>();

  constructor(
    private readonly repo: PortfolioReviewRepository,
    private readonly live: LiveTradesRepository,
    @Optional() private readonly feeds?: UserFeedManager,
    @Optional() private readonly llm?: AssistLlmService,
  ) {}

  async get(user: AssistPrincipal, opts: { refresh?: boolean } = {}, now: Date = new Date()): Promise<PortfolioReview> {
    const userId = user.userId;
    const hit = this.cache.get(userId);
    const fresh = hit && now.getTime() - hit.at < REVIEW_CACHE_MS;
    const refreshAllowed = !hit || now.getTime() - hit.at >= REFRESH_MIN_GAP_MS;
    if (hit && fresh && !(opts.refresh && refreshAllowed)) return hit.review;

    if (!opts.refresh && !hit) {
      const stored = await this.repo.latestSince(userId, new Date(now.getTime() - REVIEW_CACHE_MS)).catch(() => null);
      if (stored) {
        this.cache.set(userId, { at: Date.parse(stored.review.generatedAt), id: stored.id, review: stored.review });
        return stored.review;
      }
    }

    const running = this.inflight.get(userId);
    if (running) return running;
    const p = this.generate(user, now).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, p);
    return p;
  }

  history(userId: string): Promise<ReviewHistoryRow[]> {
    return this.repo.history(userId);
  }

  private async generate(user: AssistPrincipal, now: Date): Promise<PortfolioReview> {
    const userId = user.userId;
    const [trackers, exits, orders] = await Promise.all([
      this.repo.listTrackers(userId),
      this.live.listLiveExits(userId),
      this.live.listLiveOrders(userId),
    ]);
    const exitInputs: ExitInput[] = exits.map((e) => ({ trackerId: e.trackerId, verdictId: e.verdictId, status: e.status, fillPrice: e.fillPrice, createdAt: e.createdAt }));
    const orderInputs: OrderInput[] = orders.map((o) => ({ token: o.instrument?.token ?? null, source: o.source, at: o.entryTime ?? o.createdAt }));
    const trends = await this.holdingTrends(userId, trackers, now);

    const review = buildPortfolioReview({ userId, trackers, exits: exitInputs, orders: orderInputs, trends, now });
    const summaryWork = this.startSummary(user, review);
    review.summary = await summaryWork.first;

    let id: string | null = null;
    try {
      id = await this.repo.save(review);
    } catch (e) {
      this.logger.warn(`[portfolio-review] could not store the review for ${userId}: ${errText(e)}`);
    }
    const entry: CacheEntry = { at: now.getTime(), id, review };
    this.cache.set(userId, entry);

    // A summary that outlived the wait lands in the cached report and the stored row when it arrives.
    if (review.summary.status === 'PENDING') {
      void summaryWork.final.then(async (s) => {
        entry.review.summary = s;
        if (entry.id) await this.repo.updateSummary(entry.id, userId, s).catch(() => undefined);
      });
    }
    return review;
  }

  /** Daily candles (≈1 year) per open holding over the caller's own session; cached per token per IST day. */
  private async holdingTrends(userId: string, trackers: TrackerInput[], now: Date): Promise<Map<string, HoldingTrend>> {
    const out = new Map<string, HoldingTrend>();
    const open = new Map<string, TrackerInput>();
    for (const t of trackers) if (t.kind === 'HOLDING' && t.status === 'OPEN') open.set(t.token, t);
    if (!this.feeds) {
      for (const token of open.keys()) out.set(token, NO_TREND('no broker session wired'));
      return out;
    }
    const today = istDay(now);
    const started = Date.now();
    let first = true;
    for (const [token, t] of open) {
      const cached = this.trendCache.get(`${userId}:${token}`);
      if (cached && cached.day === today) {
        out.set(token, cached.trend);
        continue;
      }
      if (Date.now() - started > CANDLE_BUDGET_MS) {
        out.set(token, NO_TREND('candle time budget used up'));
        continue;
      }
      if (!first) await sleep(CANDLE_SPACING_MS);
      first = false;
      try {
        const bars = await this.feeds.fetchCandles(userId, token, t.exchange, '1d', new Date(now.getTime() - 370 * 86_400_000), now);
        const trend = trendFromBars((bars ?? []).map((b) => ({ close: Number(b.close), high: Number(b.high), low: Number(b.low) })));
        out.set(token, trend);
        if (trend.status === 'OK') this.trendCache.set(`${userId}:${token}`, { day: today, trend });
      } catch (e) {
        out.set(token, NO_TREND(errText(e).slice(0, 120)));
      }
    }
    return out;
  }

  /**
   * The owner-only LLM summary. `first` resolves within SUMMARY_WAIT_MS (PENDING
   * if the model is still writing); `final` resolves with the eventual outcome.
   */
  private startSummary(user: AssistPrincipal, review: PortfolioReview): { first: Promise<LlmSummary>; final: Promise<LlmSummary> } {
    const skipped = (reason: string): LlmSummary => ({ status: 'SKIPPED', text: null, reason });
    if (!this.llm) {
      const s = Promise.resolve(skipped('the AI summary is not available on this server'));
      return { first: s, final: s };
    }
    if (!this.llm.allowed(user)) {
      const s = Promise.resolve(skipped('the AI summary is available to the account owner only'));
      return { first: s, final: s };
    }
    const llm = this.llm;
    const final: Promise<LlmSummary> = llm
      .complete(SUMMARY_JOB, PORTFOLIO_REVIEW_SYSTEM_PROMPT, summaryUserTurn(review), { userId: user.userId })
      .then((a): LlmSummary => {
        const text = acceptSummary(a.answer);
        return text ? { status: 'OK', text, reason: null } : { status: 'FAILED', text: null, reason: 'the summary did not pass the wording check' };
      })
      .catch((e): LlmSummary => {
        if (e instanceof AssistBusyError) return { status: 'BUSY', text: null, reason: 'Claude is busy with live trade decisions; refresh in a few minutes.' };
        this.logger.warn(`[portfolio-review] summary failed: ${errText(e)}`);
        return { status: 'FAILED', text: null, reason: 'the AI summary could not be written this time' };
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = Promise.race([
      final,
      new Promise<LlmSummary>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'PENDING', text: null, reason: 'still being written — reload in a minute' }), SUMMARY_WAIT_MS);
      }),
    ]).finally(() => timer && clearTimeout(timer));
    return { first, final };
  }
}
