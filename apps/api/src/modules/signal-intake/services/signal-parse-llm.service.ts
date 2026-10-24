import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import {
  readInfoReply,
  readLlmReply,
  SIGNAL_INFO_SCHEMA,
  SIGNAL_INFO_SYSTEM,
  SIGNAL_PARSE_SCHEMA,
  SIGNAL_PARSE_SYSTEM,
  type InfoLlmReply,
  type LlmParseReply,
} from '../domain/llm-schema';
import { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';

/** `ai_calls.job` for every fallback parse. */
export const SIGNAL_PARSE_JOB = 'signal.parse';
/** `ai_calls.job` for every INFO extraction (the daily cap counts these rows). */
export const SIGNAL_INFO_JOB = 'signal.info';
const MAX_TOKENS = 1_200;

/** The port the intake service calls (a fake in tests). Throws on transport failure / busy slot. */
export interface SignalLlm {
  parse(text: string): Promise<LlmParseReply>;
}
export const SIGNAL_LLM = Symbol('SIGNAL_LLM');

/** INFO extraction for posts the rule extractor found no bias in. Throws on transport failure / busy slot. */
export interface SignalInfoLlm {
  info(text: string): Promise<InfoLlmReply>;
  /** `signal.info` ai_calls rows since `since` (the daily cap). */
  usedSince?(since: Date): Promise<number>;
}
export const SIGNAL_INFO_LLM = Symbol('SIGNAL_INFO_LLM');

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
export class SignalParseLlmService implements SignalLlm, SignalInfoLlm {
  private transport: MessagesTransport | null = null;
  private infoTransport: MessagesTransport | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly cfg: SignalIntakeConfig,
    @Optional() private readonly repo?: SignalIntakeRepository,
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

  /** Same model, transport and shared slot as the parse; job 'signal.info'; strict JSON. */
  async info(text: string): Promise<InfoLlmReply> {
    const request: TransportRequest = {
      model: this.cfg.llmModel,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SIGNAL_INFO_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: 'text', text: SIGNAL_INFO_SYSTEM }],
      messages: [{ role: 'user', content: `Telegram post:\n"""\n${text.slice(0, 4000)}\n"""` }],
    };
    const t = (this.infoTransport ??= this.recorded(SIGNAL_INFO_JOB));
    const message = await runInSharedSlot(this.cycle, () => t.messages.create(request), { maxWaitMs: this.cfg.llmMaxWaitMs });
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    const out = (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const reply = readInfoReply(out);
    if (!reply) throw new Error('reply is not the info schema JSON');
    return reply;
  }

  usedSince(since: Date): Promise<number> {
    return this.repo ? this.repo.aiCallsSince(SIGNAL_INFO_JOB, since) : Promise.resolve(0);
  }

  private transportOf(): MessagesTransport {
    this.transport ??= this.recorded(SIGNAL_PARSE_JOB);
    return this.transport;
  }

  private recorded(job: string): MessagesTransport {
    return directRecordedTransport({
      judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
      cli: this.cli,
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
      record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
      audit: this.calls,
      jobOf: () => job,
    });
  }
}
