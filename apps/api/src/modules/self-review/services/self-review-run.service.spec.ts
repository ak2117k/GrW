import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { TuningService } from '../tuning/tuning.service';
import { parseOption, SelfReviewRunService, minutesSinceOpenOf } from './self-review-run.service';

// Wed 2026-10-21 19:00 IST: S = 2026-10-21 (Dussehra Tue 10-20 is a holiday).
const NOW = new Date('2026-10-21T13:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function make(o: { enabled?: boolean; diagnosis?: { diagnose: jest.Mock }; pending?: unknown[]; failScorecards?: boolean } = {}) {
  const stored: Array<Record<string, unknown>> = [];
  const repo = {
    createRun: jest.fn(async (s: string) => ({ id: 'run1', sessionDate: s })),
    finishRun: jest.fn(async () => ({})),
    upsertResults: jest.fn(async (runId: string, drafts: Array<Record<string, unknown>>) => {
      for (const d of drafts) {
        const i = stored.findIndex((x) => x.kind === d.kind && x.refId === d.refId);
        if (i >= 0) stored[i] = { ...d, runId };
        else stored.push({ ...d, runId });
      }
      return drafts.length;
    }),
    results: jest.fn(async (w: { sessionDate?: string; sessions?: string[]; kinds?: string[] }) =>
      stored.filter((r) => (!w.sessionDate || r.sessionDate === w.sessionDate) && (!w.sessions || w.sessions.includes(r.sessionDate as string)) && (!w.kinds || w.kinds.includes(r.kind as string))),
    ),
    doneRunsFor: jest.fn(async () => []),
    setDiagnosisIfEmpty: jest.fn(async () => undefined),
    proposals: jest.fn(async () => o.pending ?? []),
    expire: jest.fn(async () => ({ count: 0 })),
    createProposal: jest.fn(async () => ({})),
  };
  const sources = {
    scorecards: jest.fn(async () => {
      if (o.failScorecards) throw new Error('db');
      return [
        {
          id: 'sc1', symbol: 'NIFTY28OCT2625000CE', underlying: 'NIFTY', side: 'BULLISH', window: 'OVERNIGHT',
          computedAt: new Date('2026-10-19T10:10:00Z'), total: 2, band: 'SUPPORTS', moveBp: -60,
          factors: [{ name: 'oi', points: 2, available: true }, { name: 'news', points: 1, available: true }],
        },
        // computed before the previous session: its outcome is not S
        { id: 'old', symbol: 'X', underlying: 'X', side: 'BULLISH', window: 'OVERNIGHT', computedAt: new Date('2026-10-14T10:10:00Z'), total: 1, band: 'SUPPORTS', moveBp: 10, factors: [] },
      ];
    }),
    nightVerdicts: jest.fn(async () => [
      { id: 'v1', trackerId: 't1', symbol: 'NIFTY28OCT2625000CE', verdict: 'HOLD_OVERNIGHT', confidence: 'high', createdAt: new Date('2026-10-19T10:15:00Z'), triggeredBy: ['OVERNIGHT_REVIEW'] },
    ]),
    trackers: jest.fn(async () => [{ id: 't1', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', token: '123', qty: 75, status: 'OPEN', exitPrice: null, exitTime: null }]),
    bars1m: jest.fn(async () => []),
    chainLtp: jest.fn(async () => null),
    liveExits: jest.fn(async () => []),
    newsIdeas: jest.fn(async () => []),
    scorecardTotals: jest.fn(async () => []),
    articleSentiments: jest.fn(async () => new Map()),
    dailyRangeBp: jest.fn(async () => null),
    mbmPredictions: jest.fn(async () => []),
    stockMoves: jest.fn(async (asOf: string) =>
      asOf === '2026-10-13'
        ? [
            { id: '41', symbol: 'RELIANCE', asOf: new Date('2026-10-13T00:00:00Z'), horizonDays: 5, pBig: 0.7, rankPct: 0.98, bucket: 'TOP20', resultsInWindow: false, modelId: 'm1', outcomeBig: true, outcomeRetBp: 380 },
            { id: '42', symbol: 'TCS', asOf: new Date('2026-10-13T00:00:00Z'), horizonDays: 5, pBig: 0.3, rankPct: 0.5, bucket: 'MID', resultsInWindow: false, modelId: 'm1', outcomeBig: false, outcomeRetBp: 90 },
          ]
        : [],
    ),
  };
  const tuning = new TuningService({ overrides: async () => [] });
  const svc = new SelfReviewRunService(
    repo as never,
    sources as never,
    tuning,
    { enabled: o.enabled ?? true },
    clock,
    { 'exit.openingGuardMin': 15, 'exit.persistMinSec': 120 },
    o.diagnosis as never,
  );
  return { svc, repo, sources, stored };
}

describe('SelfReviewRunService', () => {
  it('SELF_REVIEW_ENABLED=false → nothing runs', async () => {
    const { svc, repo } = make({ enabled: false });
    expect(await svc.run(NOW)).toMatchObject({ started: false });
    expect(repo.createRun).not.toHaveBeenCalled();
  });

  it('verifies S: scorecard total + factors, the overnight verdict via the underlying proxy; summary; DONE', async () => {
    const { svc, repo, stored } = make();
    const out = await svc.run(NOW);
    expect(out).toMatchObject({ started: true, runId: 'run1', session: '2026-10-21' });
    const forS = stored.filter((r) => r.sessionDate === '2026-10-21');
    expect(forS.map((r) => `${r.kind}:${r.refId}`).sort()).toEqual([
      'OVERNIGHT_VERDICT:v1', 'SCORECARD_FACTOR:sc1:news', 'SCORECARD_FACTOR:sc1:oi', 'SCORECARD_TOTAL:sc1', 'STOCK_MOVE:41', 'STOCK_MOVE:42',
    ]);
    expect(forS.find((r) => r.kind === 'SCORECARD_TOTAL')).toMatchObject({ correct: false });
    expect(forS.find((r) => r.kind === 'OVERNIGHT_VERDICT')).toMatchObject({ correct: false, details: expect.objectContaining({ proxy: 'underlying-move' }) });
    expect(stored.some((r) => r.refId === 'old')).toBe(false);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; summary: { byKind: Record<string, unknown> } }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].summary.byKind.SCORECARD_TOTAL).toMatchObject({ n: 1, wrong: 1 });
  });

  it('STOCK_MOVE: rows whose 5-session horizon closes at S (scored 5 sessions earlier) are judged; MID is null; not a factor', async () => {
    const { svc, sources, stored, repo } = make();
    await svc.run(NOW);
    // S = 10-21 → back over 10-19, 10-16, 10-15, 10-14 (10-20 holiday, weekend) → as-of 10-13.
    expect(sources.stockMoves).toHaveBeenCalledWith('2026-10-13');
    const forS = stored.filter((r) => r.sessionDate === '2026-10-21' && r.kind === 'STOCK_MOVE');
    expect(forS.find((r) => r.refId === '41')).toMatchObject({ subject: 'TOP20', correct: true });
    expect(forS.find((r) => r.refId === '42')).toMatchObject({ subject: 'MID', correct: null });
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { summary: { byKind: Record<string, unknown>; byFactor: Record<string, unknown> } }];
    expect(finish[1].summary.byKind.STOCK_MOVE).toMatchObject({ n: 2, right: 1, wrong: 0, nullCount: 1 });
    expect(Object.keys(finish[1].summary.byFactor)).not.toContain('TOP20');
  });

  it('is idempotent: a re-run upserts the same (kind, refId) rows', async () => {
    const { svc, stored } = make();
    await svc.run(NOW);
    const n = stored.length;
    await svc.run(NOW);
    expect(stored.length).toBe(n);
  });

  it('hands S’s misses (capped, factor/MBM excluded) to the diagnosis when bound; its failure does not fail the run', async () => {
    const diagnose = jest.fn(async () => {
      throw new Error('llm down');
    });
    const { svc, repo } = make({ diagnosis: { diagnose } });
    await svc.run(NOW);
    expect(diagnose).toHaveBeenCalledTimes(1);
    const misses = (diagnose.mock.calls[0] as unknown as [string, Array<{ kind: string }>])[1];
    expect(misses.every((m) => m.kind !== 'SCORECARD_FACTOR' && m.kind !== 'MBM_PREDICTION')).toBe(true);
    expect(misses.length).toBeGreaterThan(0);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1].status).toBe('DONE');
    expect(finish[1].error).toMatch(/diagnosis/);
  });

  it('a failing kind costs only itself', async () => {
    const { svc, stored, repo } = make({ failScorecards: true });
    await svc.run(NOW);
    expect(stored.some((r) => r.kind === 'OVERNIGHT_VERDICT')).toBe(true);
    const finish = repo.finishRun.mock.calls.at(-1) as unknown as [string, { status: string; error: string }];
    expect(finish[1]).toMatchObject({ status: 'DONE', error: expect.stringMatching(/SCORECARD/) });
  });

  it('expires PENDING proposals older than 14 days', async () => {
    const { svc, repo } = make({ pending: [{ id: 'p-old', key: 'k', status: 'PENDING', createdAt: new Date('2026-09-01T00:00:00Z') }] });
    await svc.run(NOW);
    expect(repo.expire).toHaveBeenCalledWith(['p-old']);
  });

  it('currentValue: override, else the env-derived default, else the code default', () => {
    const { svc } = make();
    expect(svc.currentValue('exit.persistMinSec')).toBe(120);
    expect(svc.currentValue('scorecard.factor.oi.weight')).toBe(1);
    expect(svc.currentValue('scorecard.factor.news.requireConfirmation')).toBe(false);
  });
});

describe('helpers', () => {
  it('parseOption', () => {
    expect(parseOption('NIFTY28OCT2625000CE')).toEqual({ underlying: 'NIFTY', expiry: '2026-10-28', strike: 25000, type: 'CE' });
    expect(parseOption('RELIANCE-EQ')).toBeNull();
  });
  it('minutesSinceOpenOf: minutes after the exchange open, null off-session', () => {
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-21T03:52:00Z'))).toBe(7); // 09:22 IST
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-21T02:00:00Z'))).toBeNull(); // 07:30 IST
    expect(minutesSinceOpenOf(clock, 'NFO', new Date('2026-10-20T05:00:00Z'))).toBeNull(); // holiday
  });
});
