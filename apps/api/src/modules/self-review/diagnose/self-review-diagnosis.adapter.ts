import { Injectable, Logger } from '@nestjs/common';
import type { DiagnosisMiss, DiagnosisOutput, DiagnosisPort } from '../self-review.ports';
import { LessonsService } from '../lessons/lessons.service';
import { actionable, groupStats, isDecisionKind, type MissFacts } from './actionable';
import { DiagnosisService } from './diagnosis.service';
import { diagnosisForRun, type DiagnosedMiss, type DiagnosisResult } from './types';

/**
 * Stream A's {@link DiagnosisPort} (`SELF_REVIEW_DIAGNOSIS`): diagnose the run's misses, apply
 * the result to the lessons, and hand back what goes on `self_review_runs.diagnosis` — the
 * validated misses (plus promptVersion / model) on OK, `null` when the diagnosis failed or was
 * skipped. Never throws: a failed lesson upsert is logged and the diagnosis is still returned.
 */
@Injectable()
export class SelfReviewDiagnosisAdapter implements DiagnosisPort {
  private readonly logger = new Logger(SelfReviewDiagnosisAdapter.name);

  constructor(
    private readonly diagnosis: DiagnosisService,
    private readonly lessons: LessonsService,
  ) {}

  async diagnose(runId: string, misses: DiagnosisMiss[], context?: { signalPaper?: unknown; noiseReads?: unknown; engine?: unknown }): Promise<DiagnosisOutput | null> {
    // The stored diagnosis is the gated one too, so the page never shows a lesson that was not written.
    const result = lessonGated(await this.diagnosis.diagnose(runId, misses, context), misses);
    const cases = new Map(misses.map((m) => [m.refId, { kind: m.kind as string, session: m.sessionDate, symbol: m.symbol }]));
    try {
      await this.lessons.upsertFromDiagnosis(runId, result, (refId) => cases.get(refId));
    } catch (e) {
      this.logger.warn(`[self-review] run ${runId}: lesson upsert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return diagnosisForRun(result);
  }
}

/**
 * The pattern gate on lessons (2026-11-04, wrong-decision loop goal 5): a group that explains a DECISION:* miss
 * writes its lesson only when it is actionable (>= 3 in 10 sessions, or one >= ₹5k; never NOISE). Groups of the
 * older kinds keep today's path — the lessons' own 2-session injection gate already holds them back.
 * `contradicts` still counts: following an old lesson into a wrong decision is evidence against it.
 */
export function lessonGated(result: DiagnosisResult, misses: readonly DiagnosisMiss[]): DiagnosisResult {
  if (!result || result.status !== 'OK') return result;
  const facts = new Map<string, MissFacts>(misses.map((m) => [m.refId, { sessionDate: m.sessionDate, score: m.score, kind: m.kind }]));
  const gate = (d: DiagnosedMiss): DiagnosedMiss => {
    if (!d.lessonKey || !d.refIds.some((r) => isDecisionKind(facts.get(r)?.kind))) return d;
    if (actionable(groupStats(d.refIds, facts), d.causeType)) return d;
    const { lessonKey: _k, lessonText: _t, scope: _s, ...rest } = d;
    return rest;
  };
  return { ...result, misses: result.misses.map(gate) };
}
