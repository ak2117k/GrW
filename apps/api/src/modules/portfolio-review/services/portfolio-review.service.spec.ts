import { AssistBusyError } from '../../ai-assist/assist-slot';
import { buildEvidence, OI_NOT_FNO } from '../domain/evidence';
import { closedPos, holdingRow, ist, okTrend } from '../domain/review.fixtures';
import type { HoldingCheck, PortfolioReview, ReviewRun } from '../domain/types';
import { PortfolioReviewService, RUN_STALE_MS, RUN_SYNC_WAIT_MS } from './portfolio-review.service';

const NOW = ist('2026-11-02 13:00');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(opts: { llm?: 'ok' | 'busy' | 'none' | 'denied'; hold?: Promise<void>; failTrackers?: boolean } = {}) {
  const trackers = [
    holdingRow('IVALUE-EQ', 302.87, 50, '2026-07-11 18:41', null, 199.67, { token: '1' }),
    closedPos('KEI29SEP265800CE', 271.85, 0.05, 175, '2026-08-17 14:10', '2026-09-30 15:50'),
  ];
  const stored: { id: string; review: PortfolioReview }[] = [];
  const runs = new Map<string, ReviewRun>();
  const repo = {
    listTrackers: opts.failTrackers ? jest.fn().mockRejectedValue(new Error('db down')) : jest.fn().mockResolvedValue(trackers),
    save: jest.fn(async (r: PortfolioReview) => {
      stored.push({ id: `rev${stored.length + 1}`, review: r });
      return `rev${stored.length}`;
    }),
    updateSummary: jest.fn().mockResolvedValue(undefined),
    updatePlanExplanation: jest.fn().mockResolvedValue(undefined),
    latest: jest.fn(async () => stored[stored.length - 1] ?? null),
    byId: jest.fn(async (id: string) => stored.find((s) => s.id === id)?.review ?? null),
    history: jest.fn().mockResolvedValue([]),
    createRun: jest.fn(async (r: ReviewRun) => void runs.set(r.id, { ...r })),
    finishRun: jest.fn(async (id: string, _u: string, patch: Partial<ReviewRun> & { finishedAt: Date }) => {
      const r = runs.get(id);
      if (r) runs.set(id, { ...r, ...patch, finishedAt: patch.finishedAt.toISOString() });
    }),
    runById: jest.fn(async (id: string, userId: string) => {
      const r = runs.get(id);
      return r && r.userId === userId ? r : null;
    }),
    latestRun: jest.fn().mockResolvedValue(null),
    countRunsSince: jest.fn(async () => [...runs.values()].filter((r) => r.status !== 'FAILED').length),
  };
  const live = { listLiveExits: jest.fn().mockResolvedValue([]), listLiveOrders: jest.fn().mockResolvedValue([]) };
  const planData = {
    holdingsEvidence: jest.fn(async (_u: string, holdings: HoldingCheck[]) => {
      if (opts.hold) await opts.hold;
      const trend = okTrend({ dma20: 205, dma50: 210, dma200: 260, high52w: 320, low52w: 190, ret6m: -25, ret1m: -4, atr14: 6, lastClose: 199.67 });
      return {
        trends: new Map(holdings.map((h) => [h.token, trend])),
        evidence: new Map(holdings.map((h) => [h.token, buildEvidence({ trend, price: h.ltp, news: [], oi: OI_NOT_FNO, events: [], sector: 'IT' })])),
        notes: [],
      };
    }),
    balance: jest.fn().mockResolvedValue({ status: 'LIVE', availableCash: 4827.82, asOf: NOW.toISOString() }),
    screen: jest.fn().mockResolvedValue({ candidates: [], stats: { universe: 200, fetched: 0, cachedToday: 0, passedTrend: 0, oiChecked: 0, skippedReason: null } }),
  };
  const llm =
    opts.llm === 'none'
      ? undefined
      : {
          allowed: jest.fn().mockReturnValue(opts.llm !== 'denied'),
          complete:
            opts.llm === 'busy'
              ? jest.fn().mockRejectedValue(new AssistBusyError(20_000))
              : jest.fn(async (job: string) => ({ answer: String(job) === 'portfolio.plan' ? 'Consider setting a stop on IVALUE.' : 'You are down mostly on options.', confidence: 80, offTopic: false })),
        };
  const svc = new PortfolioReviewService(repo as never, live as never, planData as never, llm as never);
  return { svc, repo, planData, llm, runs };
}

const owner = { userId: 'owner', role: 'ADMIN' };

describe('PortfolioReviewService — run on demand', () => {
  afterEach(() => jest.useRealTimers());

  it('GET latest never computes: no stored review → null, nothing read from the book or broker', async () => {
    const { svc, repo, planData } = setup();
    const r = await svc.latest('owner', NOW);
    expect(r.review).toBeNull();
    expect(r.activeRun).toBeNull();
    expect(r.quota).toMatchObject({ usedThisMonth: 0, freeLimit: 1, allowed: true, enforced: false });
    expect(repo.listTrackers).not.toHaveBeenCalled();
    expect(planData.holdingsEvidence).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('POST run computes the report + action plan, stores it, records the run DONE; latest then serves it without recomputing', async () => {
    const { svc, repo, runs } = setup({ llm: 'ok' });
    const res = await svc.startRun(owner, NOW);
    expect(res.run.status).toBe('DONE');
    expect(res.review?.summary).toEqual({ status: 'OK', text: 'You are down mostly on options.', reason: null });
    expect(res.review?.actionPlan?.explanation.text).toBe('Consider setting a stop on IVALUE.');
    expect(res.review?.actionPlan?.holdings[0]).toMatchObject({ symbol: 'IVALUE-EQ', heldQty: 50 });
    expect(res.review?.actionPlan?.sizing.balance.status).toBe('LIVE');
    expect(res.review?.digest).toMatch(/Action plan \(rule-based, not advice\)/);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect([...runs.values()][0]).toMatchObject({ status: 'DONE', reviewId: 'rev1', userId: 'owner' });
    expect(res.quota.usedThisMonth).toBe(1);
    expect(res.quota.allowed).toBe(true);

    const calls = repo.listTrackers.mock.calls.length;
    const latest = await svc.latest('owner', new Date(NOW.getTime() + 60_000));
    expect(latest.review?.generatedAt).toBe(res.review?.generatedAt);
    expect(latest.reviewId).toBe('rev1');
    expect(repo.listTrackers).toHaveBeenCalledTimes(calls);
  });

  it('a long run answers RUNNING with a run id; a second POST joins it; GET runs/:id returns the review when DONE', async () => {
    jest.useFakeTimers();
    const gate = deferred<void>();
    const { svc, repo } = setup({ hold: gate.promise });
    const p1 = svc.startRun(owner, NOW);
    await jest.advanceTimersByTimeAsync(RUN_SYNC_WAIT_MS + 10);
    const r1 = await p1;
    expect(r1.run.status).toBe('RUNNING');
    expect(r1.review).toBeNull();
    expect(r1.run.progress).toBeTruthy();

    const latest = await svc.latest('owner', NOW);
    expect(latest.activeRun?.id).toBe(r1.run.id);

    const p2 = svc.startRun(owner, NOW);
    await jest.advanceTimersByTimeAsync(RUN_SYNC_WAIT_MS + 10);
    expect((await p2).run.id).toBe(r1.run.id);
    expect(repo.createRun).toHaveBeenCalledTimes(1);

    gate.resolve();
    await jest.advanceTimersByTimeAsync(10);
    const s = await svc.runStatus('owner', r1.run.id, NOW);
    expect(s?.run.status).toBe('DONE');
    expect(s?.review?.actionPlan).toBeTruthy();
    expect(await svc.runStatus('someone-else', r1.run.id, NOW)).toBeNull();
  });

  it('a second POST within a minute of a finished run returns that run instead of a new one', async () => {
    const { svc, repo } = setup();
    const a = await svc.startRun(owner, NOW);
    const b = await svc.startRun(owner, new Date(NOW.getTime() + 30_000));
    expect(b.run.id).toBe(a.run.id);
    expect(repo.createRun).toHaveBeenCalledTimes(1);
    const c = await svc.startRun(owner, new Date(NOW.getTime() + 120_000));
    expect(c.run.id).not.toBe(a.run.id);
  });

  it('a failing run is recorded FAILED with the error; a stale RUNNING row reads as FAILED', async () => {
    const { svc, runs, repo } = setup({ failTrackers: true });
    const r = await svc.startRun(owner, NOW);
    expect(r.run.status).toBe('FAILED');
    expect(r.run.error).toMatch(/db down/);
    expect([...runs.values()][0].status).toBe('FAILED');

    const stale: ReviewRun = { id: 'old', userId: 'owner', startedAt: new Date(NOW.getTime() - RUN_STALE_MS - 1000).toISOString(), finishedAt: null, status: 'RUNNING', progress: 'x', error: null, reviewId: null };
    repo.runById.mockResolvedValueOnce(stale);
    const s = await svc.runStatus('owner', 'old', NOW);
    expect(s?.run.status).toBe('FAILED');
  });

  it('fails open on texts: busy model → BUSY; non-owner → SKIPPED with no model call; no model → SKIPPED', async () => {
    const a = await setup({ llm: 'busy' }).svc.startRun(owner, NOW);
    expect(a.review?.summary.status).toBe('BUSY');
    expect(a.review?.actionPlan?.explanation.status).toBe('BUSY');
    expect(a.review?.actionPlan?.holdings.length).toBe(1);

    const b = setup({ llm: 'denied' });
    const rb = await b.svc.startRun({ userId: 'someone', role: 'USER' }, NOW);
    expect(rb.review?.summary.status).toBe('SKIPPED');
    expect(rb.review?.actionPlan?.explanation.status).toBe('SKIPPED');
    expect(b.llm?.complete).not.toHaveBeenCalled();

    const c = await setup({ llm: 'none' }).svc.startRun(owner, NOW);
    expect(c.review?.summary.status).toBe('SKIPPED');
  });

  it('a store failure does not fail the run', async () => {
    const { svc, repo } = setup();
    repo.save.mockRejectedValue(new Error('relation "portfolio_reviews" does not exist'));
    const r = await svc.startRun(owner, NOW);
    expect(r.run.status).toBe('DONE');
    expect(r.review?.headline.trades).toBe(1);
  });

  it('the quota hook counts runs this month but never blocks', async () => {
    const { svc } = setup();
    await svc.startRun(owner, NOW);
    await svc.startRun(owner, new Date(NOW.getTime() + 120_000));
    const q = await svc.reviewQuota('owner', NOW);
    expect(q.usedThisMonth).toBe(2);
    expect(q.allowed).toBe(true);
    expect(q.enforced).toBe(false);
  });
});
