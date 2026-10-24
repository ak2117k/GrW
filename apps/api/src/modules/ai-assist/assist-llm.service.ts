import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeCliTransport, stripFences } from '../ai-gateway/providers/claude-cli.provider';
import { AiCallRepository } from '../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../ai-gateway/audit/recorded-transport';
import { withAiCallContext } from '../ai-gateway/audit/ai-call-context';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../ai-gateway/transport.types';
import { judgeTransportFrom } from '../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../trade-sentinel/services/sentinel-cycle.service';
import { ASSIST_ANSWER_SCHEMA } from './advisor-guardrail';
import { runInSharedSlot } from './assist-slot';

/** `ai_calls.job` labels for the user-facing calls. */
export type AssistJob = 'assist.news' | 'assist.advisor' | 'strategy.review' | 'strategy.suggest';

export const ASSIST_DEFAULT_MODEL = 'claude-sonnet-5';
/** How long a user-facing call may wait for the shared slot before "busy, try again". */
export const ASSIST_DEFAULT_MAX_WAIT_MS = 20_000;
const ASSIST_MAX_TOKENS = 2_000;

export interface AssistAnswer {
  answer: string;
  confidence: number;
  offTopic: boolean;
}

/** Principal shape the access gate needs (matches `AuthenticatedUser`). */
export interface AssistPrincipal {
  userId: string;
  role?: string;
}

/**
 * Who may spend the Claude session. The CLI transport is the OWNER's own
 * subscription (the sentinel's `SENTINEL_JUDGE=cli`), so in a multi-tenant
 * deployment only the owner may use it: `HUB_OWNER_USER_ID` when set, else an
 * ADMIN. Everyone else keeps the pre-existing behaviour.
 */
export function assistAllowed(user: AssistPrincipal | undefined, ownerUserId: string): boolean {
  if (!user?.userId) return false;
  if (ownerUserId) return user.userId === ownerUserId;
  return user.role === 'ADMIN';
}

/** The reply's text, or a throw for a refusal / truncation / empty reply. */
export function replyText(message: TransportMessage): string {
  const stop = message.stop_reason;
  if (stop === 'refusal') throw new Error('the model declined to answer');
  if (stop === 'max_tokens') throw new Error('the answer was cut off (max_tokens)');
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('empty reply');
  return text;
}

/** Parse a reply that MUST be JSON (no prose fallback); the caller validates the shape. */
export function parseJsonReply(message: TransportMessage): unknown {
  const text = replyText(message);
  try {
    return JSON.parse(stripFences(text));
  } catch {
    throw new Error('the reply was not JSON');
  }
}

/** Parse the model's JSON reply; a prose reply (CLI ignored the schema) is kept as the answer. */
export function parseAssistAnswer(message: TransportMessage): AssistAnswer {
  const text = replyText(message);
  try {
    const parsed = JSON.parse(stripFences(text)) as Partial<AssistAnswer>;
    if (typeof parsed.answer === 'string' && parsed.answer.trim() !== '') {
      const c = Number(parsed.confidence);
      return {
        answer: parsed.answer.trim(),
        confidence: Number.isFinite(c) ? Math.min(100, Math.max(1, Math.round(c))) : 50,
        offTopic: parsed.offTopic === true,
      };
    }
  } catch {
    // fall through: prose reply
  }
  return { answer: text, confidence: 50, offTopic: false };
}

/**
 * The one door for USER-FACING Claude calls (News "Ask Claude to analyze",
 * AI Trading Advisor chat).
 *
 * - Transport: exactly the sentinel's direct binding — `directRecordedTransport`
 *   over the SHARED `ClaudeCliTransport` instance when `SENTINEL_JUDGE=cli`
 *   (the API client otherwise). No new credentials.
 * - Ledger: one `ai_calls` row per call (job `assist.*`, tokens, latency,
 *   error) via `RecordedTransport`, with the user id from the call context.
 * - Capacity: `runInSharedSlot` over `SentinelCycleService.runShared` — never
 *   the live reserved slot; waits at most `maxWaitMs`, then `AssistBusyError`.
 */
@Injectable()
export class AssistLlmService {
  private readonly transports = new Map<AssistJob, MessagesTransport>();

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
  ) {}

  allowed(user: AssistPrincipal | undefined): boolean {
    return assistAllowed(user, this.config.get<string>('HUB_OWNER_USER_ID')?.trim() ?? '');
  }

  async complete(
    job: AssistJob,
    system: string,
    user: string,
    opts: { userId?: string; maxWaitMs?: number } = {},
  ): Promise<AssistAnswer> {
    return parseAssistAnswer(await this.send(job, system, user, ASSIST_ANSWER_SCHEMA, opts));
  }

  /**
   * Same door with a caller-supplied JSON schema. Returns the parsed JSON
   * UNVALIDATED — the caller owns the shape check. Throws on prose, refusal,
   * truncation, or {@link AssistBusyError} when no shared slot frees up.
   */
  async completeJson(
    job: AssistJob,
    system: string,
    user: string,
    schema: Record<string, unknown>,
    opts: { userId?: string; maxWaitMs?: number } = {},
  ): Promise<unknown> {
    return parseJsonReply(await this.send(job, system, user, schema, opts));
  }

  private async send(
    job: AssistJob,
    system: string,
    user: string,
    schema: Record<string, unknown>,
    opts: { userId?: string; maxWaitMs?: number },
  ): Promise<TransportMessage> {
    const request: TransportRequest = {
      model: this.config.get<string>('AI_ASSIST_MODEL')?.trim() || ASSIST_DEFAULT_MODEL,
      max_tokens: ASSIST_MAX_TOKENS,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: user }],
    };
    const transport = this.transportFor(job);
    return runInSharedSlot(
      this.cycle,
      () => withAiCallContext({ userId: opts.userId }, () => transport.messages.create(request)),
      { maxWaitMs: opts.maxWaitMs ?? ASSIST_DEFAULT_MAX_WAIT_MS },
    );
  }

  private transportFor(job: AssistJob): MessagesTransport {
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
