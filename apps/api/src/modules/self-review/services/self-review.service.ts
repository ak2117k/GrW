import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { decide } from '../domain/proposals';
import { topMisses } from '../domain/summary';
import { decisionGradeId, lessonScorecard, missCostRupees, missOutcome, scorecardRefIds, ticketKeysOf, type LessonScorecard, type MissOutcome, type RefInfo } from '../domain/findings';
import { SelfReviewRepository } from '../repositories/self-review.repository';
import { SELF_REVIEW_LESSONS, type DiagnosisMissOut, type LessonsPort } from '../self-review.ports';
import type { RunSummary } from '../self-review.types';
import { TuningService } from '../tuning/tuning.service';
import { SelfReviewRunService, toDraft } from './self-review-run.service';

/** The wire shape of `GET /api/self-review/latest` and the night report's `selfReview` section. */
export interface SelfReviewLatestView {
  run: Record<string, unknown> | null;
  summary: RunSummary | null;
  /**
   * The night's diagnosed misses. `outcome` = what each became (lesson / fix ticket / recorded one-off / noise) and
   * `costRupees` = ₹ per lot net of its decision-ledger refs (null = no ₹ figure); both absent on the undiagnosed fallback.
   */
  misses: Array<DiagnosisMissOut & { kind?: string | null; symbol?: string | null; costRupees?: number | null; outcome?: MissOutcome }>;
  lessonsAdded: Array<{ id: string; key: string; text: string; scope: string; rightCount: number; wrongCount: number; status: string }>;
  proposalsPending: number;
  /** The diagnosis' read of the signal paper trades split by OI verdict / AI judge call; null when none. */
  signalPaperAssessment?: string | null;
  /** The diagnosis' read of the exit noise reads' scores (summary.exitNoise holds the counts); null when none. */
  exitNoiseAssessment?: string | null;
  /** The diagnosis' read of the entry engine (summary.engine holds the counts); null when none. */
  engineAssessment?: string | null;
}

const MISS_CAP = 15;

/**
 * The run the page shows: the newest DONE run, unless it carries no diagnosis and another run of the same night does.
 * The 02:30 missed-moves run follows the 00:30 diagnosed one, and showing it left the page empty (prod 2026-11-10).
 */
export function shownRun<T extends { diagnosis: unknown }>(latest: T, sameSession: readonly T[]): T {
  if (latest.diagnosis != null) return latest;
  return sameSession.find((r) => r.diagnosis != null) ?? latest;
}

function readAssessment(diagnosis: unknown, key: 'signalPaperAssessment' | 'exitNoiseAssessment' | 'engineAssessment' = 'signalPaperAssessment'): string | null {
  const a = diagnosis && typeof diagnosis === 'object' && !Array.isArray(diagnosis) ? (diagnosis as Record<string, unknown>)[key] : null;
  return typeof a === 'string' && a.trim() !== '' ? a : null;
}

/** Reads for the API / night report, and the owner's approve / reject / retire decisions. */
@Injectable()
export class SelfReviewService {
  private readonly logger = new Logger(SelfReviewService.name);

  constructor(
    private readonly repo: SelfReviewRepository,
    private readonly tuning: TuningService,
    private readonly runner: SelfReviewRunService,
    @Optional() @Inject(SELF_REVIEW_LESSONS) private readonly lessonsPort?: LessonsPort,
  ) {}

  async latest(): Promise<SelfReviewLatestView> {
    const [newest, proposalsPending] = await Promise.all([this.repo.latestDoneRun().then((r) => r ?? this.repo.latestRun()), this.repo.countPending()]);
    const run = newest && newest.status === 'DONE' ? shownRun(newest, await this.repo.doneRunsFor(newest.sessionDate)) : newest;
    if (!run) return { run: null, summary: null, misses: [], lessonsAdded: [], proposalsPending };
    const [results, lessons] = await Promise.all([this.repo.results({ sessionDate: run.sessionDate }), this.repo.lessonsFromRun(run.id)]);
    const bySubject = new Map(results.map((r) => [r.refId, r]));
    const diagnosed = readMisses(run.diagnosis);
    const gradeIds = diagnosed.flatMap((m) => m.refIds.map(decisionGradeId).filter((id): id is string => !!id));
    const lessonKeys = [...new Set(diagnosed.map((m) => m.lessonKey).filter((k): k is string => !!k))];
    // Each read is a no-op on an empty list (an undiagnosed night).
    const [grades, lessonRows, ticketRows] = await Promise.all([
      this.repo.decisionGradesByIds(gradeIds),
      this.repo.lessonsByKeys(lessonKeys),
      this.repo.ticketsByKeys(ticketKeysOf(diagnosed)),
    ]);
    const gradeByRef = new Map(grades.map((g) => [`dg:${g.id}`, g]));
    const costByRef = new Map(grades.map((g) => [`dg:${g.id}`, g.deltaRupees]));
    const lessonByKey = new Map(lessonRows.map((l) => [l.key, l]));
    const ticketByKey = new Map(ticketRows.map((t) => [t.key, t]));
    const misses = diagnosed.length
      ? diagnosed.map((m) => {
          const first = bySubject.get(m.refIds[0] ?? '');
          const grade = gradeByRef.get(m.refIds[0] ?? '');
          return {
            ...m,
            kind: first?.kind ?? (grade ? `DECISION:${grade.decisionType}` : null),
            symbol: first?.symbol ?? grade?.symbol ?? null,
            costRupees: missCostRupees(m.refIds, costByRef),
            outcome: missOutcome(m, lessonByKey, ticketByKey),
          };
        })
      : topMisses(results.filter((r) => r.kind !== 'SCORECARD_FACTOR' && r.kind !== 'MBM_PREDICTION' && r.kind !== 'MBM_RELATIVE' && r.kind !== 'STOCK_MOVE').map(toDraft), MISS_CAP).map((r) => ({
          refIds: [r.refId],
          cause: `${r.predicted} → ${r.actual}`,
          kind: r.kind,
          symbol: r.symbol,
        }));
    return {
      run: {
        id: run.id,
        sessionDate: run.sessionDate,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        status: run.status,
        summary: run.summary ?? null,
        error: run.error,
        signalPaperAssessment: readAssessment(run.diagnosis),
        exitNoiseAssessment: readAssessment(run.diagnosis, 'exitNoiseAssessment'),
        engineAssessment: readAssessment(run.diagnosis, 'engineAssessment'),
      },
      summary: (run.summary as RunSummary | null) ?? null,
      misses,
      lessonsAdded: lessons.map((l) => ({ id: l.id, key: l.key, text: l.text, scope: l.scope, rightCount: l.rightCount, wrongCount: l.wrongCount, status: l.status })),
      proposalsPending,
      signalPaperAssessment: readAssessment(run.diagnosis),
      exitNoiseAssessment: readAssessment(run.diagnosis, 'exitNoiseAssessment'),
      engineAssessment: readAssessment(run.diagnosis, 'engineAssessment'),
    };
  }

  runs(limit: number) {
    return this.repo.runs(Math.min(Math.max(1, limit || 20), 200));
  }

  results(session?: string, kind?: string) {
    if (session && !/^\d{4}-\d{2}-\d{2}$/.test(session)) throw new BadRequestException('session must be YYYY-MM-DD');
    return this.repo.results({ ...(session ? { sessionDate: session } : {}), ...(kind ? { kind } : {}) }, session ? 5000 : 500);
  }

  lessons(status?: string) {
    return this.repo.lessons(status);
  }

  /** Is each lesson making its mistake rarer? Before vs after it went active, per reviewed session (domain/findings). */
  async lessonScorecard(): Promise<LessonScorecard> {
    const [runs, lessons] = await Promise.all([this.repo.diagnosedRuns(), this.repo.scorecardLessons()]);
    const refIds = scorecardRefIds(runs);
    const gradeIds = refIds.map(decisionGradeId).filter((id): id is string => !!id);
    const [grades, results] = await Promise.all([this.repo.decisionGradesByIds(gradeIds), this.repo.resultSessionsByRefIds(refIds.filter((r) => !decisionGradeId(r)))]);
    const refs = new Map<string, RefInfo>();
    for (const r of results) if (!refs.has(r.refId)) refs.set(r.refId, { sessionDate: r.sessionDate, costRupees: null });
    for (const g of grades) refs.set(`dg:${g.id}`, { sessionDate: g.sessionDate, costRupees: g.deltaRupees });
    return lessonScorecard(runs, lessons, refs);
  }

  proposals(status?: string) {
    return this.repo.proposals(status);
  }

  async retireLesson(id: string, by: string | null) {
    if (this.lessonsPort?.retire) await this.lessonsPort.retire(id, by ?? undefined);
    else if (!(await this.repo.retireLesson(id))) {
      const all = await this.repo.lessons();
      if (!all.some((l) => l.id === id)) throw new NotFoundException('lesson not found');
    }
    this.logger.log(`[self-review] lesson ${id} retired by ${by ?? 'unknown'}`);
    const row = (await this.repo.lessons()).find((l) => l.id === id);
    if (!row) throw new NotFoundException('lesson not found');
    return row;
  }

  /** PENDING → APPROVED → override written → APPLIED. Re-validated against the allow-list and bounds. */
  async approve(id: string, by: string | null, now: Date = new Date()) {
    const p = await this.repo.proposal(id);
    if (!p) throw new NotFoundException('proposal not found');
    const d = decide(p, 'approve', now);
    if (!d.ok) {
      if (d.status === 'EXPIRED') await this.repo.expire([id]);
      throw new ConflictException(d.reason);
    }
    if (d.value === undefined || !(await this.repo.approveAndApply(id, p.target, d.value, by))) {
      throw new ConflictException('proposal was decided concurrently');
    }
    await this.tuning.refresh();
    this.logger.log(`[self-review] APPLIED ${p.target}: ${JSON.stringify(p.currentValue)} → ${JSON.stringify(d.value)} (proposal ${id}, by ${by ?? 'unknown'})`);
    return this.repo.proposal(id);
  }

  async reject(id: string, by: string | null, now: Date = new Date()) {
    const p = await this.repo.proposal(id);
    if (!p) throw new NotFoundException('proposal not found');
    const d = decide(p, 'reject', now);
    if (!d.ok) {
      if (d.status === 'EXPIRED') await this.repo.expire([id]);
      throw new ConflictException(d.reason);
    }
    if (!(await this.repo.reject(id, by))) throw new ConflictException('proposal was decided concurrently');
    this.logger.log(`[self-review] REJECTED ${p.target} → ${JSON.stringify(p.proposedValue)} (proposal ${id}, by ${by ?? 'unknown'})`);
    return this.repo.proposal(id);
  }

  /** Admin re-run for the last closed session, in the background. */
  startRun(): { started: boolean; reason?: string } {
    if (!this.runner.isEnabled()) return { started: false, reason: 'SELF_REVIEW_ENABLED=false' };
    if (this.runner.isRunning()) return { started: false, reason: 'a run is already going' };
    void this.runner.run(new Date(), 'manual').catch((e) => this.logger.warn(`[self-review] manual run failed: ${e instanceof Error ? e.message : String(e)}`));
    return { started: true };
  }
}

function readMisses(diagnosis: unknown): DiagnosisMissOut[] {
  const m = diagnosis && typeof diagnosis === 'object' ? (diagnosis as { misses?: unknown }).misses : null;
  if (!Array.isArray(m)) return [];
  return m
    .filter((x): x is DiagnosisMissOut => !!x && typeof x === 'object' && Array.isArray((x as DiagnosisMissOut).refIds) && typeof (x as DiagnosisMissOut).cause === 'string')
    .slice(0, MISS_CAP);
}
