import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runInSharedSlot } from '../../ai-assist/assist-slot';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { AUTHORITY_STATE, type AuthorityStatePort } from '../../exit-authority/exit-authority.tokens';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { authorityLive } from '../domain/authority';
import type { DeskPacket } from '../domain/desk.types';
import { managerSystemPrompt, managerUserMessage } from '../domain/manager-prompt';

/** `ai_calls.job` for every manager call; config/ai-agents.json routes it to the trading agent (1 at once, 120 s). */
export const MANAGER_JOB = 'desk.manager';
/**
 * `ai_calls.job` of the supreme confirm call (trade agent exit authority). Not in config/ai-agents.json: with AI
 * agents on, an unknown job gets its own default semaphore, so a confirm never waits behind a manager run.
 */
export const SUPREME_CONFIRM_JOB = 'desk.confirm';
/** Slot wait + call (matches config/ai-agents.json desk.manager timeoutMs). */
export const MANAGER_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 12_000;

/** The raw reply text (UNPARSED: the runner parses it, so a malformed reply is stored with its text). */
export interface ManagerLlmReply {
  text: string;
  ms: number;
  model: string;
}

/**
 * The manager AI call: one desk packet → the reply text.
 *
 * - Model: DESK_MANAGER_MODEL (Opus 5.5), effort high. Reply contract in the prompt, checked by parseManagerReply
 *   (no structured-output schema: Vertex rejects its compiled grammar as too large).
 * - Prompt: the static system prompt (cache_control ephemeral), the packet last in the user message.
 * - Transport: the sentinel's direct binding wrapped in the ai_calls recorder, job 'desk.manager', userId = owner.
 * - Capacity: runInSharedSlot (lane 'signals'); with AI agents on, the trading agent serves it.
 * Throws on refusal, timeout or busy (the runner records the error and acts on nothing).
 */
@Injectable()
export class ManagerLlmService {
  private transport: MessagesTransport | null = null;
  private confirmTransport: MessagesTransport | null = null;
  private system: string | null = null;
  private authoritySystem: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    // Trade agent exit authority: live adds the trade-agents / briefs section to the system prompt. Absent ⇒ off.
    @Optional() @Inject(AUTHORITY_STATE) private readonly authority?: AuthorityStatePort | null,
  ) {}

  /** The system prompt in force: today's (off), or with the trade-agents / briefs section (authority live). */
  systemPrompt(): string {
    return authorityLive(this.authority)
      ? (this.authoritySystem ??= managerSystemPrompt(this.cfg, { authority: true }))
      : (this.system ??= managerSystemPrompt(this.cfg));
  }

  /**
   * One short supreme call outside the manager cycle (the supreme confirm): the caller's request through the same
   * recorded transport kind as decide() (job SUPREME_CONFIRM_JOB, so an AI agent gates it on its own semaphore and
   * it never queues behind a running manager call), bounded by `timeoutMs`. Returns the reply text; throws on
   * refusal, timeout or busy.
   */
  async send(userId: string, request: TransportRequest, timeoutMs: number): Promise<string> {
    const t = (this.confirmTransport ??= this.recorded(SUPREME_CONFIRM_JOB));
    const call = runInSharedSlot(this.cycle, () => withAiCallContext({ userId }, () => t.messages.create(request)), {
      maxWaitMs: timeoutMs,
      timeoutMs,
      lane: 'signals',
      job: SUPREME_CONFIRM_JOB,
    });
    const message = await withDeadline(call, timeoutMs);
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    return (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  async decide(userId: string, packet: DeskPacket): Promise<ManagerLlmReply> {
    const started = Date.now();
    const request: TransportRequest = {
      model: this.cfg.model,
      max_tokens: MAX_TOKENS,
      // No output_config.format: Vertex refused this schema ("compiled grammar is too large", 2026-11-27). The
      // prompt states the reply contract and parseManagerReply re-checks every field, so nothing is lost.
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: this.systemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: managerUserMessage(packet) }],
      cli: { effort: 'high' },
    };
    const t = (this.transport ??= this.recorded());
    const call = runInSharedSlot(this.cycle, () => withAiCallContext({ userId }, () => t.messages.create(request)), {
      maxWaitMs: MANAGER_TIMEOUT_MS,
      timeoutMs: MANAGER_TIMEOUT_MS,
      lane: 'signals',
      job: MANAGER_JOB,
    });
    const message = await withDeadline(call, MANAGER_TIMEOUT_MS);
    if (message.stop_reason === 'refusal') throw new Error('the model declined');
    const text = (message.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { text, ms: Date.now() - started, model: this.cfg.model };
  }

  private recorded(job: string = MANAGER_JOB): MessagesTransport {
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

/** Reject once `ms` has passed (the CLI path has no caller-side abort; the agent path aborts on its own budget). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`desk manager AI timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
