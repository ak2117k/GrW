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

  it('diagnoses, upserts lessons with each refId kind, returns the run diagnosis', async () => {
    const result: DiagnosisResult = {
      status: 'OK', sent: 1, dropped: 0, promptVersion: 'd1', model: 'm',
      misses: [{ refIds: ['v1'], cause: 'c', category: 'TIMING', lessonKey: 'k-one', lessonText: 'T.' }],
    };
    const diagnosis = { diagnose: jest.fn().mockResolvedValue(result) };
    const lessons = { upsertFromDiagnosis: jest.fn().mockResolvedValue({ created: [], updated: [], retired: [] }) };
    const out = await new SelfReviewDiagnosisAdapter(diagnosis as never, lessons as never).diagnose('run1', [miss('v1', 'OVERNIGHT_VERDICT')]);
    expect(out).toEqual({ misses: result.misses, promptVersion: 'd1', model: 'm' });
    const [runId, passed, kindOf] = lessons.upsertFromDiagnosis.mock.calls[0];
    expect([runId, passed, kindOf('v1'), kindOf('x')]).toEqual(['run1', result, 'OVERNIGHT_VERDICT', undefined]);
  });

  it('FAILED → null; a failed lesson upsert does not lose the diagnosis', async () => {
    const failed = { diagnose: jest.fn().mockResolvedValue({ status: 'FAILED', misses: [], sent: 1, dropped: 0, promptVersion: 'd1' }) };
    const ok = { diagnose: jest.fn().mockResolvedValue({ status: 'OK', misses: [], sent: 1, dropped: 0, promptVersion: 'd1' }) };
    const broken = { upsertFromDiagnosis: jest.fn().mockRejectedValue(new Error('db')) };
    expect(await new SelfReviewDiagnosisAdapter(failed as never, broken as never).diagnose('r', [miss('a', 'NEWS_IDEA')])).toBeNull();
    expect(await new SelfReviewDiagnosisAdapter(ok as never, broken as never).diagnose('r', [miss('a', 'NEWS_IDEA')])).toEqual({ misses: [], promptVersion: 'd1', model: undefined });
  });
});
