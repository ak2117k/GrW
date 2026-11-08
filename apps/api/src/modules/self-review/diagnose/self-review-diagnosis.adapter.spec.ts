import { Logger } from '@nestjs/common';
import { SelfReviewDiagnosisAdapter } from './self-review-diagnosis.adapter';
import type { DiagnosisResult } from './types';
import type { DiagnosisMiss } from '../self-review.ports';

const miss = (refId: string, kind: DiagnosisMiss['kind']): DiagnosisMiss => ({
  sessionDate: '2026-10-21', kind, refId, subject: null, symbol: 'NIFTY', predicted: 'p', actual: 'a', correct: false, score: -1, details: null,
});

describe('SelfReviewDiagnosisAdapter (stream A DiagnosisPort)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('diagnoses, upserts lessons with each refId kind, session and symbol, returns the run diagnosis', async () => {
    const result: DiagnosisResult = {
      status: 'OK', sent: 1, dropped: 0, promptVersion: 'd1', model: 'm',
      misses: [{ refIds: ['v1'], cause: 'c', category: 'TIMING', lessonKey: 'k-one', lessonText: 'T.' }],
    };
    const diagnosis = { diagnose: jest.fn().mockResolvedValue(result) };
    const lessons = { upsertFromDiagnosis: jest.fn().mockResolvedValue({ created: [], updated: [], retired: [] }) };
    const out = await new SelfReviewDiagnosisAdapter(diagnosis as never, lessons as never).diagnose('run1', [miss('v1', 'OVERNIGHT_VERDICT')]);
    expect(out).toEqual({ misses: result.misses, promptVersion: 'd1', model: 'm' });
    const [runId, passed, caseOf] = lessons.upsertFromDiagnosis.mock.calls[0];
    expect([runId, passed, caseOf('v1'), caseOf('x')]).toEqual(['run1', result, { kind: 'OVERNIGHT_VERDICT', session: '2026-10-21', symbol: 'NIFTY' }, undefined]);
  });

  it('a DECISION group writes its lesson only when actionable (2 cheap misses: no; one ≥ ₹5k: yes); legacy groups unchanged', async () => {
    const dm = (refId: string, score: number, sessionDate = '2026-11-04'): DiagnosisMiss => ({ ...miss(refId, 'OVERNIGHT_VERDICT'), kind: 'DECISION:EXIT', score, sessionDate });
    const result: DiagnosisResult = {
      status: 'OK', sent: 4, dropped: 0, promptVersion: 'd8', model: 'm',
      misses: [
        { refIds: ['dg:a', 'dg:b'], cause: 'c', category: 'TIMING', causeType: 'REASONING', lessonKey: 'cheap-pair', lessonText: 'T.' },
        { refIds: ['dg:c'], cause: 'c', category: 'TIMING', causeType: 'REASONING', lessonKey: 'big-one', lessonText: 'T.' },
        { refIds: ['v1'], cause: 'c', category: 'TIMING', lessonKey: 'legacy', lessonText: 'T.' },
      ],
    };
    const lessons = { upsertFromDiagnosis: jest.fn().mockResolvedValue({ created: [], updated: [], retired: [] }) };
    const out = await new SelfReviewDiagnosisAdapter({ diagnose: jest.fn().mockResolvedValue(result) } as never, lessons as never).diagnose('run1', [
      dm('dg:a', 400, '2026-11-03'), dm('dg:b', 400), dm('dg:c', -5200), miss('v1', 'OVERNIGHT_VERDICT'),
    ]);
    const passed = lessons.upsertFromDiagnosis.mock.calls[0][1] as DiagnosisResult;
    expect(passed.misses.map((m) => m.lessonKey)).toEqual([undefined, 'big-one', 'legacy']);
    expect(out?.misses.map((m) => m.lessonKey)).toEqual([undefined, 'big-one', 'legacy']);
  });

  it('FAILED throws its reason so the run records it; a failed lesson upsert does not lose the diagnosis', async () => {
    const failed = { diagnose: jest.fn().mockResolvedValue({ status: 'FAILED', misses: [], reason: 'LLM call failed: x', sent: 1, dropped: 0, promptVersion: 'd1' }) };
    const ok = { diagnose: jest.fn().mockResolvedValue({ status: 'OK', misses: [], sent: 1, dropped: 0, promptVersion: 'd1' }) };
    const broken = { upsertFromDiagnosis: jest.fn().mockRejectedValue(new Error('db')) };
    await expect(new SelfReviewDiagnosisAdapter(failed as never, broken as never).diagnose('r', [miss('a', 'NEWS_IDEA')])).rejects.toThrow('LLM call failed: x');
    expect(await new SelfReviewDiagnosisAdapter(ok as never, broken as never).diagnose('r', [miss('a', 'NEWS_IDEA')])).toEqual({ misses: [], promptVersion: 'd1', model: undefined });
  });
});
