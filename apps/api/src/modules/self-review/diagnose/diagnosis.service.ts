import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessagesTransport, TransportMessage } from '../../ai-gateway/transport.types';
import { SENTINEL_EFFORT_TRIGGERED, SENTINEL_MODEL } from '../../trade-sentinel/prompts/sentinel-system-prompt';
import { LessonsService } from '../lessons/lessons.service';
import type { LessonRecord } from '../lessons/types';
import {
  buildDiagnosisUserMessage,
  capMisses,
  DIAGNOSIS_MAX_TOKENS,
  DIAGNOSIS_PROMPT_VERSION,
  DIAGNOSIS_SCHEMA,
  DIAGNOSIS_SYSTEM_PROMPT,
  extractJsonObject,
  validateDiagnosis,
} from './diagnosis-prompt';
import type { DiagnosisResult, MissInput } from './types';

/** DI token: the transport the diagnosis is served by (see `SelfReviewLearningModule`). */
export const SELF_REVIEW_LLM = 'SELF_REVIEW_LLM';
/** The `ai_calls.job` label of the diagnosis call (direct, gateway-off path). */
export const SELF_REVIEW_DIAGNOSE_JOB = 'self-review.diagnose';

type Effort = 'low' | 'medium' | 'high';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/**
 * One batched LLM call per self-review run that explains the session's misses and names
 * lessons (docs/superpowers/plans/2026-10-21-self-review-contract.md, "Diagnose").
 *
 * Served by the sentinel judge transport (`SENTINEL_JUDGE=cli|api`) on the overnight
 * review's routing — `SENTINEL_MODEL_TRIGGERED` (else the compiled Opus default) at
 * `SENTINEL_EFFORT_TRIGGERED`. FAIL-SOFT: it never throws; a transport error, a refusal, a
 * truncated or malformed reply all return `status: 'FAILED'` with the reason, and the run
 * stores `diagnosis = null`.
 */
@Injectable()
export class DiagnosisService {
  private readonly logger = new Logger(DiagnosisService.name);

  constructor(
    @Inject(SELF_REVIEW_LLM) private readonly llm: MessagesTransport,
    private readonly lessons: LessonsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private tier(): { model: string; effort: Effort } {
    const raw = (k: string) => this.config?.get<string>(k)?.trim();
    const effort = raw('SENTINEL_EFFORT_TRIGGERED') as Effort | undefined;
    return {
      model: raw('SENTINEL_MODEL_TRIGGERED') || SENTINEL_MODEL,
      effort: effort && EFFORTS.includes(effort) ? effort : SENTINEL_EFFORT_TRIGGERED,
    };
  }

  async diagnose(runId: string, misses: readonly MissInput[]): Promise<DiagnosisResult> {
    const base = { promptVersion: DIAGNOSIS_PROMPT_VERSION };
    const { sent, dropped } = capMisses(misses);
    if (sent.length === 0) return { ...base, status: 'SKIPPED', misses: [], reason: 'no misses', sent: 0, dropped: 0 };

    let active: LessonRecord[] = [];
    try {
      active = await this.lessons.activeFor('ALL');
    } catch (e) {
      this.logger.warn(`[self-review] run ${runId}: active lessons unavailable, diagnosing without them: ${msg(e)}`);
    }
    const tier = this.tier();
    let reply: TransportMessage;
    try {
      reply = await this.llm.messages.create({
        model: tier.model,
        max_tokens: DIAGNOSIS_MAX_TOKENS,
        output_config: { effort: tier.effort, format: { type: 'json_schema', schema: DIAGNOSIS_SCHEMA as unknown as Record<string, unknown> } },
        system: [{ type: 'text', text: DIAGNOSIS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildDiagnosisUserMessage(sent, active) }],
      });
    } catch (e) {
      return this.failed(runId, `LLM call failed: ${msg(e)}`, sent.length, dropped, tier.model);
    }
    if (reply.stop_reason === 'refusal' || reply.stop_reason === 'max_tokens' || reply.stop_reason === 'model_context_window_exceeded') {
      return this.failed(runId, `reply stopped: ${reply.stop_reason}`, sent.length, dropped, tier.model);
    }
    try {
      const text = (reply.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const diagnosed = validateDiagnosis(
        extractJsonObject(text),
        sent.map((m) => m.refId),
        new Set(active.map((l) => l.key)),
        scoredFactors(sent),
      );
      const ungrounded = diagnosed.filter((d) => d.dropped);
      this.logger.log(`[self-review] run ${runId}: diagnosed ${diagnosed.length} groups from ${sent.length} misses (${dropped} over the cap)`);
      if (ungrounded.length > 0) this.logger.log(`[self-review] run ${runId}: discarded ${ungrounded.map((d) => d.dropped).join(' | ')}`);
      return { ...base, status: 'OK', misses: diagnosed, sent: sent.length, dropped, model: tier.model };
    } catch (e) {
      return this.failed(runId, `reply rejected: ${msg(e)}`, sent.length, dropped, tier.model);
    }
  }

  private failed(runId: string, reason: string, sent: number, dropped: number, model: string): DiagnosisResult {
    this.logger.warn(`[self-review] run ${runId}: diagnosis skipped — ${reason}`);
    return { status: 'FAILED', misses: [], reason, sent, dropped, model, promptVersion: DIAGNOSIS_PROMPT_VERSION };
  }
}

/** refId → factor points, for the scorecard misses that carry them (`details.factors`). */
export function scoredFactors(misses: readonly MissInput[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const m of misses) {
    const f = (m.details as { factors?: unknown } | null | undefined)?.factors;
    if (m.kind !== 'SCORECARD_TOTAL' || !f || typeof f !== 'object' || Array.isArray(f)) continue;
    const points = Object.fromEntries(Object.entries(f).filter(([, p]) => typeof p === 'number'));
    if (Object.keys(points).length > 0) out.set(m.refId, points as Record<string, number>);
  }
  return out;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
