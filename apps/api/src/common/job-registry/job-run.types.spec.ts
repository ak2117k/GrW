import { JOB_RUN_RETENTION_DAYS, retentionCutoff } from './job-run.types';

describe('job-run retention', () => {
  // NOTE: there is deliberately no `expect(JOB_RUN_RETENTION_DAYS).toBe(30)`.
  // A test asserting a constant equals the literal it is defined as cannot
  // fail except when someone edits both in the same keystroke. The cutoff test
  // below pins 30 days transitively through real arithmetic, which is the
  // behaviour that actually matters.

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
