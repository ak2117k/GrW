import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { readLlmReply, SIGNAL_PARSE_SCHEMA, SIGNAL_PARSE_SYSTEM, type LlmParseReply } from '../domain/llm-schema';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';

/** `ai_calls.job` for every fallback parse. */
export const SIGNAL_PARSE_JOB = 'signal.parse';
const MAX_TOKENS = 1_200;

/** The port the intake service calls (a fake in tests). Throws on transport failure / busy slot. */
export interface SignalLlm {
  parse(text: string): Promise<LlmParseReply>;
}
export const SIGNAL_LLM = Symbol('SIGNAL_LLM');

/**
 * The LLM fallback for pre-filter positives the rule parser could not read.
 *
 * - Model: SIGNAL_PARSE_MODEL (cheap: claude-haiku-5-5), effort low, strict JSON schema.
 * - Transport: the sentinel's direct binding (`SENTINEL_JUDGE` cli | api) wrapped in the ai_calls
 *   recorder with job 'signal.parse' — exactly how ai-assist does it; no new credentials.
 * - Capacity: `runInSharedSlot` over `SentinelCycleService.runShared` — the shared slot only, NEVER
 *   the live reserved slot; waits at most SIGNAL_PARSE_MAX_WAIT_MS, then AssistBusyError (the intake
 *   keeps the message LLM_PENDING and retries it while it is still fresh).
 */
@Injectable()
export class SignalParseLlmService implements SignalLlm {
  private transport: MessagesTransport | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly cfg: SignalIntakeConfig,
  ) {}

  async parse(text: string): Promise<LlmParseReply> {
    const request: TransportRequest = {
      model: this.cfg.llmModel,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SIGNAL_PARSE_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: SIGNAL_PARSE_SYSTEM }],
      messages: [{ role: 'user', content: `Telegram post:\n"""\n${text.slice(0, 4000)}\n"""` }],
    };
    const t = this.transportOf();
    const message = await runInSharedSlot(this.cycle, () => t.messages.create(request), { maxWaitMs: this.cfg.llmMaxWaitMs });
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    const out = (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const reply = readLlmReply(out);
    if (!reply) throw new Error('reply is not the signal schema JSON');
    return reply;
  }

  private transportOf(): MessagesTransport {
    this.transport ??= directRecordedTransport({
      judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
      cli: this.cli,
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
      audit: this.calls,
      jobOf: () => SIGNAL_PARSE_JOB,
    });
    return this.transport;
  }
}
