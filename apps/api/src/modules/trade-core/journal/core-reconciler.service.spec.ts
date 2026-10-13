import type { AuditService } from '../../../common/audit/audit.service';
import type { JobRunnerService } from '../../../common/job-registry';
import type { CoreOrder } from '../execution/execution.types';
import { cashPlan, NOW, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { CORE_RECON_JOB, CoreReconciler } from './core-reconciler.service';
import { JournalRiskReads } from './journal-risk-reads';
import type { ReconSnapshot } from './recon-checks';
import { MemoryJournalStore } from './testing/memory-journal-store';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function setup() {
  const h = lifecycleHarness();
  const store = new MemoryJournalStore();
  const journal = store.port();
  // Stream E does not depend on Task 11: a listener that writes a summary row is enough here.
  const closed = { positionClosed: jest.fn(async (userId: string, positionId: string) => void (await store.summaryRepo.createIfAbsent(store.sampleSummary({ userId, positionId, intentId: positionId })))) };
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const recon = new CoreReconciler(
    h.positions.repo, h.ledger, store.summaryRepo, store.repo, journal, closed, h.adapter, h.defaults,
    { isOpen: () => h.session.open }, jobs as unknown as JobRunnerService, audit as unknown as AuditService,
  );
  return { h, store, journal, closed, jobs, audit, recon, reads: new JournalRiskReads(store.repo) };
}

async function closeOne(s: ReturnType<typeof setup>) {
  const p = await s.h.lifecycle.openPosition(openRequest());
  await s.h.price(500);
  await s.h.price(515);
  await s.h.price(515);
  return p;
}

const mismatches = (s: ReturnType<typeof setup>) => s.store.rows.filter((r) => r.type === 'RECON_MISMATCH');

/** A snapshot with one stuck EXIT order: a finding that is never repaired automatically. */
function stuckExitSnapshot(now: Date): ReconSnapshot {
  const p = positionFor(cashPlan(), { status: 'EXITING', entryFilledQty: 100, openQty: 100, updatedAt: new Date(now.getTime() - 3_600_000) });
  const exit: CoreOrder = {
    id: 'o_exit', userId: 'user_A', idempotencyKey: 'int_1:exit:1', vehicle: 'CASH_INTRADAY', instrument: p.instrument, side: 'SELL', qty: 100, filledQty: 0,
    avgFillPrice: null, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500, purpose: 'EXIT', strategyVersionId: p.strategyVersionId,
    positionId: p.id, state: 'NEW', rejectReason: null, submittedAt: new Date(now.getTime() - 3_600_000), triggeredAt: null, updatedAt: new Date(now.getTime() - 3_600_000),
  };
  // The filled entry the EXITING position came from (so the position row agrees with its orders).
  const entry: CoreOrder = { ...exit, id: 'o_entry', idempotencyKey: 'int_1:entry', side: 'BUY', purpose: 'ENTRY', state: 'FILLED', filledQty: 100, avgFillPrice: 500 };
  return {
    now, positions: [p], ordersByPosition: new Map([[p.id, [entry, exit]]]), fillQtyByOrder: new Map([[entry.id, 100]]), lastFillAtByOrder: new Map(), marginByOrder: new Map(),
    summarised: new Set(), interestTokensToday: new Set(), stuckAfterMs: 60_000,
  };
}

describe('CoreReconciler (spec §8.3, J17, Review Focus 4 and 5)', () => {
  it('a clean day has no finding and writes nothing', async () => {
    const s = setup();
    const p = await closeOne(s);
    await s.closed.positionClosed('user_A', p.id);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(mismatches(s)).toEqual([]);
  });

  it('a cleanly closed position raises no NIGHTLY finding: the real M3 ledger books +X margin on the entry order and −X on the exit order, and the check sums per position', async () => {
    const s = setup();
    const p = await closeOne(s);
    await s.closed.positionClosed('user_A', p.id);
    const orderIds = s.h.ordersOf(p.id).map((o) => o.id);
    const perOrder = await s.h.ledger.marginByOrder('user_A', orderIds);
    expect([...perOrder.values()].some((m) => !m.isZero())).toBe(true); // the per-order trap is real
    s.h.advance(new Date('2026-10-12T15:45:00.000+05:30').getTime() - Date.now());
    expect(await s.recon.reconcileUser('user_A', 'NIGHTLY', new Date())).toEqual([]);
    await s.recon.runNightly(new Date());
    expect(mismatches(s)).toEqual([]);
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: [] });
  });

  it('a missing summary is repaired, not flagged', async () => {
    const s = setup();
    const p = await closeOne(s);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(s.closed.positionClosed).toHaveBeenCalledWith('user_A', p.id);
    expect(mismatches(s)).toEqual([]);
  });

  it('a repair that fails becomes a RECON_MISMATCH that blocks only that strategy', async () => {
    const s = setup();
    await closeOne(s);
    s.closed.positionClosed.mockRejectedValueOnce(new Error('summary db down'));
    const found = await s.recon.reconcileUser('user_A', 'INTRADAY', new Date());
    expect(found).toEqual([expect.objectContaining({ check: 'SUMMARY_MISSING' })]);
    expect(mismatches(s)).toEqual([expect.objectContaining({ userId: 'user_A', strategyId: 'cs_ungated', payload: expect.objectContaining({ check: 'SUMMARY_MISSING' }) })]);
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_ungated'] });
  });

  it('a stuck entry order is cancelled and flagged; the owner’s ack lifts the block, audited; another user cannot ack it', async () => {
    const s = setup();
    await s.h.lifecycle.openPosition(openRequest()); // no price ever arrives: the entry stays open
    const settings = await s.h.defaults.settings();
    if (!settings.ok) throw new Error('fixture settings');
    s.h.advance(2 * settings.settings.noPriceRejectMs + 1_000);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([expect.objectContaining({ check: 'STUCK_ORDER', repair: 'CANCEL_ENTRY' })]);
    await s.h.settle();
    expect(s.h.paper.orders[0].state).toBe('CANCELLED');
    const [m] = mismatches(s);
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_ungated'] });
    await expect(s.recon.ack('user_B', m.id, 'not mine')).rejects.toThrow(/not found/);
    await s.recon.ack('user_A', m.id, 'matcher restarted; checked by hand');
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: [] });
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_A', target: `core_journal:${m.id}`, meta: { reason: 'matcher restarted; checked by hand' } }));
  });

  it('an unrepairable finding is journaled once a day; after an ack it blocks again on a later day (Review Focus 5)', async () => {
    const s = setup();
    const day1 = new Date();
    const day2 = new Date(day1.getTime() + 86_400_000);
    const snapshot = jest.spyOn(CoreReconciler.prototype as unknown as { snapshot: (u: string, n: Date) => Promise<ReconSnapshot> }, 'snapshot');
    snapshot.mockImplementation(async (_u: string, now: Date) => stuckExitSnapshot(now));
    const cancel = jest.spyOn(s.h.adapter, 'cancel');
    await s.recon.reconcileUser('user_A', 'INTRADAY', day1);
    const perDay = mismatches(s).length; // STUCK_ORDER (the exit) and STUCK_EXITING
    expect(mismatches(s).map((m) => m.payload.check).sort()).toEqual(['STUCK_EXITING', 'STUCK_ORDER']);
    await s.recon.reconcileUser('user_A', 'INTRADAY', day1);
    expect(mismatches(s)).toHaveLength(perDay);
    expect(mismatches(s).find((m) => m.payload.check === 'STUCK_ORDER')?.payload).toMatchObject({ repair: null, orderId: 'o_exit' });
    expect(cancel).not.toHaveBeenCalled(); // an exit is never cancelled
    for (const m of mismatches(s)) await s.recon.ack('user_A', m.id, 'seen');
    expect((await s.reads.reconBlock('user_A')).strategyIds).toEqual([]);
    await s.recon.reconcileUser('user_A', 'INTRADAY', day2);
    expect(mismatches(s)).toHaveLength(2 * perDay);
    expect((await s.reads.reconBlock('user_A')).strategyIds).toEqual(['cs_ungated']);
  });

  it('the 5-minute run does nothing while NSE is closed; the nightly run goes through the job runner', async () => {
    const s = setup();
    await closeOne(s);
    s.h.session.open = false;
    const spy = jest.spyOn(s.recon, 'reconcileUser');
    await s.recon.runIntraday(new Date());
    expect(spy).not.toHaveBeenCalled();
    await s.recon.runNightly(new Date());
    expect(s.jobs.run).toHaveBeenCalledWith(CORE_RECON_JOB, expect.objectContaining({ onRedisError: 'run-anyway' }), expect.any(Function));
    expect(spy).toHaveBeenCalledWith('user_A', 'NIGHTLY', expect.any(Date));
  });

  it('an unreadable snapshot is logged, never a finding', async () => {
    const s = setup();
    await closeOne(s);
    jest.spyOn(s.h.ledger, 'listPositionOrders').mockRejectedValueOnce(new Error('db down'));
    await expect(s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).resolves.toEqual([]);
    expect(mismatches(s)).toEqual([]);
  });
});

describe('CoreReconciler — FILLS_VS_ORDER read race (review fix 3)', () => {
  it('a fill that commits between the order read and the fills read is not a RECON_MISMATCH', async () => {
    const s = setup();
    await s.h.lifecycle.openPosition(openRequest()); // the entry order is OPEN, nothing filled
    const settings = await s.h.defaults.settings();
    if (!settings.ok) throw new Error('fixture settings');
    s.h.advance(2 * settings.settings.noPriceRejectMs + 1_000); // the order row itself is old and quiet
    const [order] = s.h.paper.orders;
    const realFills = s.h.ledger.fillsFor.bind(s.h.ledger);
    // The fills read sees a fill the order read did not (it committed in between, just now).
    const racing = jest.spyOn(s.h.ledger, 'fillsFor').mockImplementation(async (userId, ids) => [
      ...(await realFills(userId, ids)),
      { id: 'f_race', orderId: order.id, userId: 'user_A', qty: order.qty, createdAt: new Date() } as unknown as Awaited<ReturnType<typeof realFills>>[number],
    ]);
    const found = await s.recon.reconcileUser('user_A', 'INTRADAY', new Date());
    expect(found.filter((f) => f.check === 'FILLS_VS_ORDER')).toEqual([]);
    expect(mismatches(s).filter((m) => m.payload.check === 'FILLS_VS_ORDER')).toEqual([]);
    racing.mockRestore();
  });
});
