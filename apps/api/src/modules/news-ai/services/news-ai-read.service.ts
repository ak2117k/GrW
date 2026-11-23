import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { buildReadMessage, type ArticleForRead } from '../domain/news-ai.inputs';
import { validateReadReply } from '../domain/news-ai.validate';
import { NEWS_AI_CONFIG, type NewsAiConfig } from '../news-ai.config';
import { NEWS_AI_STORE, type NewsAiStore } from '../news-ai.repository';
import { NEWS_AI_LLM, NewsAiReplyError, type NewsAiLlm } from './news-ai-llm.service';

export interface ReadRunSummary {
  ran: boolean;
  reason?: string;
  picked?: number;
  stored?: number;
  failed?: number;
  busy?: number;
  /** Picked but not tried this tick because the provider failed (not attempts). */
  skipped?: number;
  /** The first provider/transport error of the tick, when one stopped it. */
  providerError?: string;
}

type ReadOutcome = 'stored' | 'failed' | 'busy' | { providerError: string };

const RETENTION_DAYS = 30;
const DAY = 86_400_000;

/**
 * Per-article AI read (job 'news.sentiment'). Every 2 min: up to NEWS_AI_BATCH articles fetched in
 * the last NEWS_AI_LOOKBACK_HOURS that are not filtered, not yet read and have fewer than 3 failed
 * attempts (first read + at most 2 retries), fresh ones before retries, newest first. Each reply is
 * validated; only a reply-level failure (unparseable JSON, failed validation) is recorded as a failed
 * attempt, and it is NOT stored. A provider/transport error (429 / 529 / 5xx, timeout, auth, a 400
 * for the request shape) is NOT an attempt: it stops the tick (no new calls start) and the articles
 * wait for the next tick, so an outage or a bad deploy can never use up the backlog's attempts.
 * A busy shared slot (CLI) or agent is not an attempt either. NEWS_AI=off stops it.
 */
@Injectable()
export class NewsAiReadService {
  private readonly logger = new Logger(NewsAiReadService.name);
  private running = false;
  private lastPruneDay = '';

  constructor(
    @Inject(NEWS_AI_STORE) private readonly store: NewsAiStore,
    @Inject(NEWS_AI_LLM) private readonly llm: NewsAiLlm,
    @Inject(NEWS_AI_CONFIG) private readonly cfg: NewsAiConfig,
  ) {}

  @Cron('30 */2 * * * *', { name: 'news-ai-read', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<ReadRunSummary> {
    if (!bootJobsEnabled()) return { ran: false, reason: 'boot jobs off' };
    return this.run(new Date());
  }

  async run(now: Date): Promise<ReadRunSummary> {
    if (!this.cfg.enabled) return { ran: false, reason: 'NEWS_AI off' };
    if (this.running) return { ran: false, reason: 'previous run still going' };
    this.running = true;
    try {
      if (!(await this.store.tablesReady())) return { ran: false, reason: 'news-ai tables missing' };
      await this.maybePrune(now);
      const since = new Date(now.getTime() - this.cfg.lookbackHours * 3_600_000);
      const batch = await this.store.readCandidates(since, this.cfg.maxAttempts, this.cfg.batch);
      const out = { stored: 0, failed: 0, busy: 0 };
      let providerError: string | undefined;
      let started = 0;
      const worker = async () => {
        while (started < batch.length && providerError === undefined) {
          const a = batch[started++];
          const r = await this.readOne(a);
          if (typeof r === 'object') providerError ??= r.providerError;
          else out[r]++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.cfg.concurrency, batch.length) }, worker));
      const skipped = batch.length - started;
      if (providerError !== undefined) {
        this.logger.warn(`[news-ai] provider error, tick stopped (not counted as attempts; ${skipped} not tried): ${providerError}`);
      }
      if (out.failed) this.logger.warn(`[news-ai] read ${out.stored}/${batch.length}, ${out.failed} failed`);
      return { ran: true, picked: batch.length, ...out, skipped, ...(providerError !== undefined ? { providerError } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[news-ai] read run failed: ${msg}`);
      return { ran: true, reason: msg };
    } finally {
      this.running = false;
    }
  }

  private async readOne(a: ArticleForRead): Promise<ReadOutcome> {
    let reply: unknown;
    try {
      reply = await this.llm.readArticle(buildReadMessage(a));
    } catch (e) {
      // No capacity (CLI shared slot, or the agent at its concurrency cap): never started, not an attempt.
      if (e instanceof AssistBusyError || (e instanceof Error && e.name === 'AgentBusyError')) return 'busy';
      const msg = e instanceof Error ? e.message : String(e);
      // The model answered but the reply was unusable: that is about this article, an attempt.
      if (e instanceof NewsAiReplyError) {
        await this.fail(a, msg);
        return 'failed';
      }
      // Provider / transport error: says nothing about the article. Not an attempt; stop the tick.
      return { providerError: msg };
    }
    const v = validateReadReply(reply);
    if (!v.ok) {
      await this.fail(a, `invalid reply: ${v.error}`);
      return 'failed';
    }
    try {
      await this.store.saveRead(a.id, this.cfg.readModel, v.value);
    } catch (e) {
      // A storage failure says nothing about the reply: not counted as an attempt, retried next tick.
      this.logger.warn(`[news-ai] could not store read for ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
      return 'failed';
    }
    return 'stored';
  }

  private async fail(a: ArticleForRead, error: string): Promise<void> {
    await this.store.recordFailure(a.id, error).catch((e: unknown) => {
      this.logger.warn(`[news-ai] could not record failure for ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async maybePrune(now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    if (day === this.lastPruneDay) return;
    this.lastPruneDay = day;
    await this.store.prune(new Date(now.getTime() - RETENTION_DAYS * DAY)).catch((e: unknown) => {
      this.logger.warn(`[news-ai] prune failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
