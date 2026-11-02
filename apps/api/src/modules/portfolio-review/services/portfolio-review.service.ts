import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AssistLlmService, type AssistJob, type AssistPrincipal } from '../../ai-assist/assist-llm.service';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { LiveTradesRepository } from '../../portfolio/repositories/live-trades.repository';
import { baseSym, buildActionPlan } from '../domain/action-plan';
import { ACTION_PLAN_SYSTEM_PROMPT, acceptPlanExplanation, actionPlanUserTurn } from '../domain/plan-prompt';
import { istMonthStart, reviewQuotaFrom } from '../domain/quota';
import { buildPortfolioReview, portfolioReviewDigest } from '../domain/report';
import { PORTFOLIO_REVIEW_SYSTEM_PROMPT, acceptSummary, summaryUserTurn } from '../domain/summary-prompt';
import type { ExitInput, LlmSummary, OrderInput, PortfolioReview, ReviewQuota, ReviewRun } from '../domain/types';
import { PortfolioReviewRepository, type ReviewHistoryRow } from '../repositories/portfolio-review.repository';
import { BrokerBudget, PlanDataService } from './plan-data.service';

/** POST /run waits this long for the run to finish before answering RUNNING (the page then polls). */
export const RUN_SYNC_WAIT_MS = 15_000;
/** A RUNNING row older than this (e.g. the process restarted mid-run) is read as FAILED. */
export const RUN_STALE_MS = 15 * 60_000;
/** A new run at most this often per user: inside the gap the last run is returned instead. */
export const RUN_MIN_GAP_MS = 60_000;
/** How long the run waits for each LLM text (summary, plan explanation) before storing it as PENDING. */
export const SUMMARY_WAIT_MS = 45_000;
/** In-memory runs are kept this long for polling, then only the DB answers. */
const RUN_MEMORY_MS = 60 * 60_000;
/** `ai_calls.job` labels. Not in ai-assist's AssistJob union (this module does not edit ai-assist). */
const SUMMARY_JOB = 'portfolio.review' as unknown as AssistJob;
const PLAN_JOB = 'portfolio.plan' as unknown as AssistJob;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GET /api/portfolio-review: the latest STORED review (never computed on read) + run / quota state. */
export interface LatestReviewResponse {
  review: PortfolioReview | null;
  reviewId: string | null;
  /** The run in progress for this user, if any (the page shows its progress and polls). */
  activeRun: ReviewRun | null;
  lastRun: ReviewRun | null;
  quota: ReviewQuota;
}

/** POST /run and GET /runs/:id. `review` is set once the run is DONE. */
export interface RunResponse {
  run: ReviewRun;
  review: PortfolioReview | null;
  quota: ReviewQuota;
}

interface LiveRun {
  run: ReviewRun;
  promise: Promise<PortfolioReview | null>;
  review: PortfolioReview | null;
}

/**
 * Portfolio review, run on demand (owner 2026-11-02: "it should be a button to press"). Opening the
 * page reads the latest STORED review only; POST /run records a portfolio_review_runs row and computes:
 * the backward-looking report (domain/report.ts) and the forward-looking action plan
 * (domain/action-plan.ts) from the caller's real broker book, daily candles + futures OI over the
 * caller's OWN broker session (within PlanDataService's call cap and time boxes), the broker balance,
 * news / events / sectors from the DB, and — owner only — two plain-language texts through the
 * advisor's Claude door. Fails open everywhere. Writes only portfolio_reviews / portfolio_review_runs.
 * The monthly quota is counted (reviewQuota) but NOT enforced.
 */
@Injectable()
export class PortfolioReviewService {
  private readonly logger = new Logger(PortfolioReviewService.name);
  private readonly active = new Map<string, LiveRun>();
  private readonly recent = new Map<string, LiveRun>();

  constructor(
    private readonly repo: PortfolioReviewRepository,
    private readonly live: LiveTradesRepository,
    private readonly planData: PlanDataService,
    @Optional() private readonly llm?: AssistLlmService,
  ) {}

  /** The latest stored review. NEVER computes. */
  async latest(userId: string, now: Date = new Date()): Promise<LatestReviewResponse> {
    const [stored, lastRun, quota] = await Promise.all([
      this.repo.latest(userId).catch((e) => {
        this.logger.warn(`[portfolio-review] latest read failed for ${userId}: ${errText(e)}`);
        return null;
      }),
      this.repo.latestRun(userId).catch(() => null),
      this.reviewQuota(userId, now),
    ]);
    const mem = this.active.get(userId);
    return {
      review: stored?.review ?? null,
      reviewId: stored?.id ?? null,
      activeRun: mem ? { ...mem.run } : null,
      lastRun: mem ? { ...mem.run } : lastRun ? this.staleCheck(lastRun, now) : null,
      quota,
    };
  }

  /** The monthly-quota hook: runs started (RUNNING / DONE) this IST month. NOT enforced — `allowed` is always true. */
  async reviewQuota(userId: string, now: Date = new Date()): Promise<ReviewQuota> {
    const since = istMonthStart(now);
    let used: number;
    try {
      used = await this.repo.countRunsSince(userId, since);
    } catch {
      used = [...this.recent.values()].filter((l) => l.run.userId === userId && l.run.status !== 'FAILED' && Date.parse(l.run.startedAt) >= since.getTime()).length;
    }
    return reviewQuotaFrom(used, now);
  }

  /**
   * Start a review run (or join the one in progress). Answers within RUN_SYNC_WAIT_MS: DONE with the
   * review when it finished, else RUNNING — the page polls GET /runs/:id.
   */
  async startRun(user: AssistPrincipal, now: Date = new Date()): Promise<RunResponse> {
    const userId = user.userId;
    this.prune(now);
    const quota = await this.reviewQuota(userId, now); // counted, not enforced (quota.allowed is always true)
    const inProgress = this.active.get(userId);
    if (inProgress) return this.answerWithin(inProgress, quota);

    const last = [...this.recent.values()].filter((l) => l.run.userId === userId).sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))[0];
    if (last && last.run.status === 'DONE' && now.getTime() - Date.parse(last.run.startedAt) < RUN_MIN_GAP_MS) {
      return { run: { ...last.run }, review: last.review, quota };
    }

    const run: ReviewRun = { id: randomUUID(), userId, startedAt: now.toISOString(), finishedAt: null, status: 'RUNNING', progress: 'Starting', error: null, reviewId: null };
    await this.repo.createRun(run).catch((e) => this.logger.warn(`[portfolio-review] could not record the run for ${userId}: ${errText(e)}`));
    const liveRun: LiveRun = { run, review: null, promise: Promise.resolve(null) };
    liveRun.promise = this.execute(user, liveRun, now)
      .then((review) => {
        liveRun.review = review;
        return review;
      })
      .catch(() => null)
      .finally(() => this.active.delete(userId));
    this.active.set(userId, liveRun);
    this.recent.set(run.id, liveRun);
    return this.answerWithin(liveRun, { ...quota, usedThisMonth: quota.usedThisMonth + 1, note: reviewQuotaFrom(quota.usedThisMonth + 1, now).note });
  }

  /** A run's state (scoped to the caller), with the review once DONE; null when unknown. */
  async runStatus(userId: string, runId: string, now: Date = new Date()): Promise<RunResponse | null> {
    const quota = await this.reviewQuota(userId, now);
    const mem = this.recent.get(runId);
    if (mem && mem.run.userId === userId) return { run: { ...mem.run }, review: mem.run.status === 'DONE' ? mem.review : null, quota };
    const row = await this.repo.runById(runId, userId).catch(() => null);
    if (!row) return null;
    const run = this.staleCheck(row, now);
    const review = run.status === 'DONE' && run.reviewId ? await this.repo.byId(run.reviewId, userId).catch(() => null) : null;
    return { run, review, quota };
  }

  history(userId: string): Promise<ReviewHistoryRow[]> {
    return this.repo.history(userId);
  }

  private staleCheck(run: ReviewRun, now: Date): ReviewRun {
    if (run.status === 'RUNNING' && now.getTime() - Date.parse(run.startedAt) > RUN_STALE_MS) {
      return { ...run, status: 'FAILED', error: run.error ?? 'the run did not finish (the server restarted?) — run it again' };
    }
    return run;
  }

  private prune(now: Date): void {
    for (const [id, l] of this.recent) if (l.run.status !== 'RUNNING' && now.getTime() - Date.parse(l.run.startedAt) > RUN_MEMORY_MS) this.recent.delete(id);
  }

  private async answerWithin(l: LiveRun, quota: ReviewQuota): Promise<RunResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([l.promise, new Promise((r) => (timer = setTimeout(r, RUN_SYNC_WAIT_MS)))]).finally(() => timer && clearTimeout(timer));
    return { run: { ...l.run }, review: l.run.status === 'DONE' ? l.review : null, quota };
  }

  private async execute(user: AssistPrincipal, l: LiveRun, now: Date): Promise<PortfolioReview> {
    const userId = user.userId;
    const progress = (t: string) => {
      l.run.progress = t;
    };
    try {
      progress('Reading your trades and holdings');
      const [trackers, exits, orders] = await Promise.all([this.repo.listTrackers(userId), this.live.listLiveExits(userId), this.live.listLiveOrders(userId)]);
      const exitInputs: ExitInput[] = exits.map((e) => ({ trackerId: e.trackerId, verdictId: e.verdictId, status: e.status, fillPrice: e.fillPrice, createdAt: e.createdAt }));
      const orderInputs: OrderInput[] = orders.map((o) => ({ token: o.instrument?.token ?? null, source: o.source, at: o.entryTime ?? o.createdAt }));
      const inputs = { userId, trackers, exits: exitInputs, orders: orderInputs, now };

      // The open holdings first (no trend), then their evidence, then the full report with trends.
      const budget = new BrokerBudget();
      const bare = buildPortfolioReview({ ...inputs, trends: new Map() });
      const hold = await this.planData.holdingsEvidence(userId, bare.holdings, budget, now, progress);
      const review = buildPortfolioReview({ ...inputs, trends: hold.trends });

      progress('Reading your available balance');
      const balance = await this.planData.balance(userId, budget, now);
      progress('Screening F&O stocks for new ideas');
      const held = new Set(review.holdings.map((h) => baseSym(h.symbol)));
      const screen = await this.planData.screen(userId, held, budget, now, progress);
      review.actionPlan = buildActionPlan({
        holdings: review.holdings,
        evidence: hold.evidence,
        balance,
        candidates: screen.candidates,
        screen: screen.stats,
        brokerCalls: { used: budget.used, cap: budget.cap },
        dataNotes: hold.notes,
        now,
      });
      review.digest = portfolioReviewDigest(review);

      progress('Writing the plain-language summaries');
      const summaryWork = this.startText(user, SUMMARY_JOB, PORTFOLIO_REVIEW_SYSTEM_PROMPT, () => summaryUserTurn(review), acceptSummary);
      review.summary = await summaryWork.first;
      // The plan explanation goes after the summary (one shared Claude slot).
      const planWork = this.startText(user, PLAN_JOB, ACTION_PLAN_SYSTEM_PROMPT, () => actionPlanUserTurn(review.actionPlan!), acceptPlanExplanation, summaryWork.final);
      review.actionPlan.explanation = await planWork.first;

      progress('Saving');
      let id: string | null = null;
      try {
        id = await this.repo.save(review);
      } catch (e) {
        this.logger.warn(`[portfolio-review] could not store the review for ${userId}: ${errText(e)}`);
      }
      if (id) {
        const reviewId = id;
        if (review.summary.status === 'PENDING') {
          void summaryWork.final.then((s) => {
            review.summary = s;
            return this.repo.updateSummary(reviewId, userId, s).catch(() => undefined);
          });
        }
        if (review.actionPlan.explanation.status === 'PENDING') {
          void planWork.final.then((s) => {
            if (review.actionPlan) review.actionPlan.explanation = s;
            return this.repo.updatePlanExplanation(reviewId, userId, s).catch(() => undefined);
          });
        }
      }
      Object.assign(l.run, { status: 'DONE', finishedAt: new Date().toISOString(), reviewId: id, progress: null, error: null });
      await this.repo.finishRun(l.run.id, userId, { status: 'DONE', finishedAt: new Date(l.run.finishedAt as string), reviewId: id, error: null, progress: null }).catch(() => undefined);
      this.logger.log(`[portfolio-review] run ${l.run.id} for ${userId} done: ${review.actionPlan.holdings.length} holdings, ${review.actionPlan.ideas.length} ideas, broker calls ${budget.used}/${budget.cap}`);
      return review;
    } catch (e) {
      const msg = errText(e).slice(0, 300);
      this.logger.warn(`[portfolio-review] run ${l.run.id} for ${userId} failed: ${msg}`);
      Object.assign(l.run, { status: 'FAILED', finishedAt: new Date().toISOString(), error: msg, progress: null });
      await this.repo.finishRun(l.run.id, userId, { status: 'FAILED', finishedAt: new Date(), reviewId: null, error: msg, progress: null }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * One owner-only LLM text. `first` resolves within SUMMARY_WAIT_MS of its start (PENDING if the
   * model is still writing); `final` with the eventual outcome. `after` delays the start until a
   * previous text settled (the Claude slot is shared).
   */
  private startText(
    user: AssistPrincipal,
    job: AssistJob,
    system: string,
    turn: () => string,
    accept: (t: string) => string | null,
    after: Promise<unknown> = Promise.resolve(),
  ): { first: Promise<LlmSummary>; final: Promise<LlmSummary> } {
    const skipped = (reason: string): LlmSummary => ({ status: 'SKIPPED', text: null, reason });
    if (!this.llm) {
      const s = Promise.resolve(skipped('the AI text is not available on this server'));
      return { first: s, final: s };
    }
    if (!this.llm.allowed(user)) {
      const s = Promise.resolve(skipped('the AI text is available to the account owner only'));
      return { first: s, final: s };
    }
    const llm = this.llm;
    const final: Promise<LlmSummary> = after
      .catch(() => undefined)
      .then(() => llm.complete(job, system, turn(), { userId: user.userId }))
      .then((a): LlmSummary => {
        const text = accept(a.answer);
        return text ? { status: 'OK', text, reason: null } : { status: 'FAILED', text: null, reason: 'the text did not pass the wording check' };
      })
      .catch((e): LlmSummary => {
        if (e instanceof AssistBusyError) return { status: 'BUSY', text: null, reason: 'Claude is busy with live trade decisions; run the review again later for the text.' };
        this.logger.warn(`[portfolio-review] ${String(job)} failed: ${errText(e)}`);
        return { status: 'FAILED', text: null, reason: 'the AI text could not be written this time' };
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The wait is counted from now (not from `after`), so a slow previous text never stretches the run.
    const first = Promise.race([
      final,
      new Promise<LlmSummary>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'PENDING', text: null, reason: 'still being written — reload in a minute' }), SUMMARY_WAIT_MS);
      }),
    ]).finally(() => timer && clearTimeout(timer));
    return { first, final };
  }
}
