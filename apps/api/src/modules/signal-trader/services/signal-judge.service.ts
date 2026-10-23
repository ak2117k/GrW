import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { judgeTransportFrom } from '../../trade-sentinel/services/llm-transport';
import { SentinelCycleService } from '../../trade-sentinel/services/sentinel-cycle.service';
import { runInSharedSlot, type SharedSlotRunner } from '../../ai-assist/assist-slot';
import { SIGNAL_JUDGE_JOB, SIGNAL_JUDGE_SCHEMA, SIGNAL_JUDGE_SYSTEM, parseJudgeVerdict, type JudgeVerdict } from '../domain/judge';

/** DI seam: the transport the judge uses (tests inject a fake). */
export const SIGNAL_JUDGE_TRANSPORT = Symbol('SIGNAL_JUDGE_TRANSPORT');

export type JudgeOutcome =
  | { ok: true; verdict: JudgeVerdict; latencyMs: number }
  | { ok: false; reason: 'judge_unavailable' | 'judge_invalid'; detail: string; latencyMs: number };

const JUDGE_MAX_TOKENS = 4_000;

/**
 * The signal entry judge. Same transport as the sentinel (SENTINEL_JUDGE=api|cli, ledgered in
 * ai_calls as job 'signal.judge') and the SAME capacity door as the user-facing calls:
 * `SentinelCycleService.runShared` through `runInSharedSlot` — it starts only when a NON-reserved
 * slot is free, so a live sentinel exit always keeps its reserved slot. Priority is therefore below
 * live exits by construction. No slot within `slotWaitMs`, or no answer within `timeoutMs` →
 * `judge_unavailable` (the caller SKIPs). A late answer after a timeout is discarded.
 */
@Injectable()
export class SignalJudgeService {
  private readonly logger = new Logger(SignalJudgeService.name);
  private transport: MessagesTransport | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cycle: SentinelCycleService,
    @Optional() private readonly cli?: ClaudeCliTransport,
    @Optional() private readonly calls?: AiCallRepository,
    @Optional() @Inject(SIGNAL_JUDGE_TRANSPORT) private readonly injected?: MessagesTransport,
  ) {}

  async judge(
    packet: Record<string, unknown>,
    opts: { model: string; timeoutMs: number; slotWaitMs: number; userId: string | null },
  ): Promise<JudgeOutcome> {
    const started = Date.now();
    const request: TransportRequest = {
      model: opts.model,
      max_tokens: JUDGE_MAX_TOKENS,
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SIGNAL_JUDGE_SCHEMA } },
      system: [{ type: 'text', text: SIGNAL_JUDGE_SYSTEM }],
      messages: [{ role: 'user', content: JSON.stringify(packet) }],
    } as TransportRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no verdict within ${Math.round(opts.timeoutMs / 1000)} s`)), opts.timeoutMs);
    });
    try {
      const transport = this.transportFor();
      const call = runInSharedSlot(
        this.cycle as unknown as SharedSlotRunner,
        () => withAiCallContext({ userId: opts.userId ?? undefined }, () => transport.messages.create(request)),
        { maxWaitMs: Math.min(opts.slotWaitMs, opts.timeoutMs) },
      );
      call.catch(() => undefined); // a late rejection after the timeout is noise
      const message = await Promise.race([call, timeout]);
      try {
        return { ok: true, verdict: parseJudgeVerdict(message), latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, reason: 'judge_invalid', detail: errText(err), latencyMs: Date.now() - started };
      }
    } catch (err) {
      this.logger.warn(`[signal-judge] unavailable: ${errText(err)}`);
      return { ok: false, reason: 'judge_unavailable', detail: errText(err), latencyMs: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private transportFor(): MessagesTransport {
    if (this.injected) return this.injected;
    if (!this.transport) {
      if (!this.cli || !this.calls) throw new Error('the AI gateway is not wired into this module');
      this.transport = directRecordedTransport({
        judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
        cli: this.cli,
        apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
        record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
        audit: this.calls,
        jobOf: () => SIGNAL_JUDGE_JOB,
      });
    }
    return this.transport;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
