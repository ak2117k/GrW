import { JOB_RUN_RETENTION_DAYS, retentionCutoff } from './job-run.types';

describe('job-run retention', () => {
  it('retains 30 days', () => {
    expect(JOB_RUN_RETENTION_DAYS).toBe(30);
  });

  it('computes the cutoff 30 days before now', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    expect(retentionCutoff(now).toISOString()).toBe('2026-07-22T10:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    retentionCutoff(now);
    expect(now.toISOString()).toBe('2026-08-21T10:00:00.000Z');
  });
});
