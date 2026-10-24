import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeCliTransport, stripFences } from '../../ai-gateway/providers/claude-cli.provider';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../../ai-gateway/transport.types';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { ASSIST_DEFAULT_MAX_WAIT_MS, ASSIST_DEFAULT_MODEL, assistAllowed, type AssistPrincipal } from '../../ai-assist/assist-llm.service';
import { runInSharedSlot } from '../../ai-assist/assist-slot';

/** `ai_calls.job` labels. */
export type BacktestJob = 'backtest.spec' | 'backtest.summary';

export const BACKTEST_AI_DEFAULT_TIMEOUT_MS = 200_000;

export class BacktestAiTimeoutError extends Error {
  constructor(ms: number) {
    super(`Claude did not answer within ${Math.round(ms / 1000)} s — please try again.`);
    this.name = 'BacktestAiTimeoutError';
  }
}

/** The text of a model reply parsed as JSON (fences tolerated); throws on refusal / cut-off / prose. */
export function parseJsonReply(message: TransportMessage): unknown {
  if (message.stop_reason === 'refusal') throw new Error('the model declined');
  if (message.stop_reason === 'max_tokens') throw new Error('the reply was cut off (max_tokens)');
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('empty reply');
  try {
    return JSON.parse(stripFences(text));
  } catch {
    throw new Error('the reply was not JSON');
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BacktestAiTimeoutError(ms)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Claude for the backtest assistant — the same door as the News/Advisor calls (AssistLlmService):
 * the sentinel's transport binding (`SENTINEL_JUDGE`, the shared ClaudeCliTransport — the owner's
 * existing session — or the API key), one `ai_calls` row per call (jobs backtest.spec /
 * backtest.summary), and the sentinel's NON-reserved shared slot via runInSharedSlot (never the
 * live reserved slot; "busy" after AI_ASSIST max wait). Owner only (`HUB_OWNER_USER_ID`, else ADMIN).
 */
@Injectable()
export class BacktestLlmService {
  private readonly transports = new Map<BacktestJob, MessagesTransport>();

  constructor(
    private readonly config: ConfigService,
    private readonly cli: ClaudeCliTransport,
    private readonly calls: AiCallRepository,
    private readonly cycle: SentinelCycleService,
  ) {}

  allowed(user: AssistPrincipal | undefined): boolean {
    return assistAllowed(user, this.config.get<string>('HUB_OWNER_USER_ID')?.trim() ?? '');
  }

  async completeJson(
    job: BacktestJob,
    system: string,
    user: string,
    schema: Record<string, unknown>,
    opts: { userId?: string; maxTokens: number; effort?: 'low' | 'medium' | 'high' },
  ): Promise<unknown> {
    const request: TransportRequest = {
      model: this.config.get<string>('AI_ASSIST_MODEL')?.trim() || ASSIST_DEFAULT_MODEL,
      max_tokens: opts.maxTokens,
      output_config: { effort: opts.effort ?? 'medium', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: user }],
    };
    const transport = this.transportFor(job);
    const timeoutMs = Number(this.config.get<string>('BACKTEST_AI_TIMEOUT_MS')) || BACKTEST_AI_DEFAULT_TIMEOUT_MS;
    const message = await withTimeout(
      runInSharedSlot(
        this.cycle,
        () => withAiCallContext({ userId: opts.userId }, () => transport.messages.create(request)),
        { maxWaitMs: ASSIST_DEFAULT_MAX_WAIT_MS },
      ),
      timeoutMs,
    );
    return parseJsonReply(message);
  }

  private transportFor(job: BacktestJob): MessagesTransport {
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
