import { toJobFreshness } from './health.jobs';

const NOW = new Date('2026-08-21T10:00:00.000Z');

describe('toJobFreshness', () => {
  it('carries RUNNING through, so a stale in-flight row is diagnosable', () => {
    // A crashed process leaves outcome=RUNNING with a startedAt that keeps
    // ageing. Consumers distinguish "busy" from "died" by reading ageSec
    // alongside the outcome, so the outcome must survive this mapping intact.
    const out = toJobFreshness(
      [
        {
          jobName: 'instrument-refresh',
          startedAt: new Date('2026-08-21T08:00:00.000Z'),
          finishedAt: null,
          outcome: 'RUNNING',
          error: null,
          durationMs: null,
        },
      ],
      ['instrument-refresh'],
      NOW,
    );
    expect(out['instrument-refresh'].outcome).toBe('RUNNING');
    expect(out['instrument-refresh'].ageSec).toBe(7200);
    expect(out['instrument-refresh'].at).toBe('2026-08-21T08:00:00.000Z');
  });

  it('reports a job that has never run as at:null, NOT ageSec:0', () => {
    const out = toJobFreshness([], ['sentinel-tick'], NOW);
    expect(out['sentinel-tick']).toEqual({
      at: null,
      ageSec: null,
      outcome: null,
      durationMs: null,
      error: null,
    });
  });

  it('reports age in seconds for a job that has run', () => {
    const out = toJobFreshness(
      [
        {
          jobName: 'sentinel-tick',
          startedAt: new Date('2026-08-21T09:59:00.000Z'),
          finishedAt: new Date('2026-08-21T09:59:02.000Z'),
          outcome: 'SUCCESS',
          error: null,
          durationMs: 2000,
        },
      ],
      ['sentinel-tick'],
      NOW,
    );
    expect(out['sentinel-tick'].ageSec).toBe(60);
    expect(out['sentinel-tick'].outcome).toBe('SUCCESS');
  });

  it('includes a recorded job that was not in the expected list', () => {
    const out = toJobFreshness(
      [
        {
          jobName: 'orphan-job',
          startedAt: new Date('2026-08-21T09:00:00.000Z'),
          finishedAt: null,
          outcome: 'FAILED',
          error: 'exploded',
          durationMs: null,
        },
      ],
      ['sentinel-tick'],
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual(['orphan-job', 'sentinel-tick']);
    expect(out['orphan-job'].error).toBe('exploded');
  });
});
