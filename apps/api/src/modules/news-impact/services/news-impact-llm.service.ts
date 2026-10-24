import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import { ClaudeCliTransport, stripFences } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { NEWS_IMPACT_SCHEMA, NEWS_IMPACT_SYSTEM } from '../domain/impact';
import { NEWS_IMPACT_CONFIG, type NewsImpactConfig } from '../news-impact.config';
import { NEWS_IMPACT_JOB } from '../news-impact.repository';

const MAX_TOKENS = 6_000;

/** The port the impact service calls (a fake in tests). Returns the parsed JSON, unvalidated. */
export interface ImpactLlm {
  analyse(userMessage: string): Promise<unknown>;
}
export const IMPACT_LLM = Symbol('IMPACT_LLM');

/**
 * One batched call per run to the cheap model (NEWS_IMPACT_MODEL, default haiku), effort low, strict
 * JSON schema. Transport = the sentinel's direct binding (SENTINEL_JUDGE cli | api) recorded in
 * ai_calls as job 'news.impact' (the daily cap counts these rows) — exactly as signal-intake does it.
 * Capacity: runInSharedSlot over SentinelCycleService.runShared — the shared slot only, NEVER the
 * live reserved slot; AssistBusyError after NEWS_IMPACT_MAX_WAIT_MS (the run is skipped, retried next time).
 */
@Injectable()
export class NewsImpactLlmService implements ImpactLlm {
  private transport: MessagesTransport | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(NEWS_IMPACT_CONFIG) private readonly cfg: NewsImpactConfig,
  ) {}

  async analyse(userMessage: string): Promise<unknown> {
    const request: TransportRequest = {
      model: this.cfg.model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: NEWS_IMPACT_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: NEWS_IMPACT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    };
    const t = (this.transport ??= directRecordedTransport({
      judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
      cli: this.cli,
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
      audit: this.calls,
      jobOf: () => NEWS_IMPACT_JOB,
    }));
    const message = await runInSharedSlot(
      this.cycle,
      () => withAiCallContext({ userId: this.cfg.ownerUserId ?? undefined }, () => t.messages.create(request)),
      { maxWaitMs: this.cfg.maxWaitMs },
    );
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    if (message.stop_reason === 'max_tokens') throw new Error('the reply was cut off (max_tokens)');
    const text = (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    try {
      return JSON.parse(stripFences(text));
    } catch {
      throw new Error('the reply was not JSON');
    }
  }
}
