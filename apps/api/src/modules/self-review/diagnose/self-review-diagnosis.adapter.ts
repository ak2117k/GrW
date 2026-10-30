import { Injectable, Logger } from '@nestjs/common';
import type { DiagnosisMiss, DiagnosisOutput, DiagnosisPort } from '../self-review.ports';
import { LessonsService } from '../lessons/lessons.service';
import { DiagnosisService } from './diagnosis.service';
import { diagnosisForRun } from './types';

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

  async diagnose(runId: string, misses: DiagnosisMiss[], context?: { signalPaper?: unknown; noiseReads?: unknown }): Promise<DiagnosisOutput | null> {
    const result = await this.diagnosis.diagnose(runId, misses, context);
    const cases = new Map(misses.map((m) => [m.refId, { kind: m.kind as string, session: m.sessionDate, symbol: m.symbol }]));
    try {
      await this.lessons.upsertFromDiagnosis(runId, result, (refId) => cases.get(refId));
    } catch (e) {
      this.logger.warn(`[self-review] run ${runId}: lesson upsert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return diagnosisForRun(result);
  }
}
