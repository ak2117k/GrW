import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { parseJsonReply } from '../../ai-assist/assist-llm.service';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { NEWS_BRIEF_SCHEMA, NEWS_BRIEF_SYSTEM, NEWS_READ_SCHEMA, NEWS_READ_SYSTEM } from '../domain/news-ai.schemas';
import { NEWS_AI_CONFIG, NEWS_BRIEF_JOB, NEWS_SENTIMENT_JOB, type NewsAiConfig } from '../news-ai.config';

/** The port the services call (a fake in tests). Both return the parsed JSON, UNVALIDATED. */
export interface NewsAiLlm {
  readArticle(userMessage: string): Promise<unknown>;
  writeBrief(userMessage: string): Promise<unknown>;
}
export const NEWS_AI_LLM = Symbol('NEWS_AI_LLM');

/**
 * The call went through but the model's reply could not be used (not JSON). This is the only
 * error from the port that says something about the article, so the read job counts it as an
 * attempt. Anything else thrown (429 / 529 / 5xx, timeout, auth, a 400 for the whole request
 * shape) is a provider or transport error and is never counted.
 */
export class NewsAiReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewsAiReplyError';
    Object.setPrototypeOf(this, NewsAiReplyError.prototype);
  }
}

type Job = typeof NEWS_SENTIMENT_JOB | typeof NEWS_BRIEF_JOB;

interface JobProfile {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  system: string;
  schema: Record<string, unknown>;
}

/**
 * Claude through the app's one transport: `directRecordedTransport` (SENTINEL_JUDGE = vertex on prod),
 * one `ai_calls` row per call with job 'news.sentiment' (Sonnet, medium) or 'news.brief' (Opus, high);
 * with AI_AGENTS=on the agent registry routes each job (config/ai-agents.json).
 * Capacity: on the metered transports (vertex / api / bedrock) calls go straight out — the owner
 * lifted the token constraint; on the CLI they take the sentinel's SHARED slot (never the live one).
 */
@Injectable()
export class NewsAiLlmService implements NewsAiLlm {
  private readonly transports = new Map<Job, MessagesTransport>();

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(NEWS_AI_CONFIG) private readonly cfg: NewsAiConfig,
  ) {}

  readArticle(userMessage: string): Promise<unknown> {
    return this.send(NEWS_SENTIMENT_JOB, userMessage);
  }

  writeBrief(userMessage: string): Promise<unknown> {
    return this.send(NEWS_BRIEF_JOB, userMessage);
  }

  profileFor(job: Job): JobProfile {
    return job === NEWS_SENTIMENT_JOB
      ? { model: this.cfg.readModel, effort: 'medium', maxTokens: 2_000, system: NEWS_READ_SYSTEM, schema: NEWS_READ_SCHEMA as unknown as Record<string, unknown> }
      : // 16k stays under the SDK's non-streaming ceiling (~21k tokens), as the advisor does.
        { model: this.cfg.briefModel, effort: 'high', maxTokens: 16_000, system: NEWS_BRIEF_SYSTEM, schema: NEWS_BRIEF_SCHEMA as unknown as Record<string, unknown> };
  }

  private async send(job: Job, userMessage: string): Promise<unknown> {
    const p = this.profileFor(job);
    const request: TransportRequest = {
      model: p.model,
      max_tokens: p.maxTokens,
      output_config: { effort: p.effort, format: { type: 'json_schema', schema: p.schema } },
      system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
      cli: { effort: p.effort },
    };
    const t = this.transportFor(job);
    const call = () => withAiCallContext({ userId: this.cfg.ownerUserId ?? undefined }, () => t.messages.create(request));
    const message =
      judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')) === 'cli'
        ? await runInSharedSlot(this.cycle, call, { maxWaitMs: this.cfg.maxWaitMs, job })
        : await call();
    try {
      return parseJsonReply(message);
    } catch (e) {
      throw new NewsAiReplyError(e instanceof Error ? e.message : String(e));
    }
  }

  private transportFor(job: Job): MessagesTransport {
    let t = this.transports.get(job);
    if (!t) {
      t = directRecordedTransport({
        judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
        cli: this.cli,
        apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
        record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
        audit: this.calls,
        jobOf: () => job,
      });
      this.transports.set(job, t);
    }
    return t;
  }
}
