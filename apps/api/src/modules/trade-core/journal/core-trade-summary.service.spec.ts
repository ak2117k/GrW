import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { CoreTradeSummaryService } from './core-trade-summary.service';
import { MemoryJournalStore } from './testing/memory-journal-store';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

async function closedTrade() {
  const h = lifecycleHarness();
  const store = new MemoryJournalStore();
  const corpus = { entrySetup: jest.fn(), outcome: jest.fn().mockResolvedValue(undefined) };
  const svc = new CoreTradeSummaryService(h.positions.repo, h.ledger, store.summaryRepo, corpus);
  const p = await h.lifecycle.openPosition(openRequest());
  await h.price(500);
  await h.price(515); // the 3 % target: the exit is placed
  await h.price(515); // and filled
  return { h, store, corpus, svc, p };
}

describe('CoreTradeSummaryService (J16, Review Focus 4)', () => {
  it('writes one summary from the real ledger: gross and charges equal the funds, net = gross − charges', async () => {
    const { h, store, corpus, svc, p } = await closedTrade();
    const s = await svc.writeFor('user_A', p.id);
    const funds = await h.ledger.funds('user_A');
    expect(s).toMatchObject({ positionId: p.id, intentId: 'int_1', exitReason: 'TARGET', qty: 100, grossPnl: funds.realisedPnl, charges: funds.charges, mtfInterest: '0.00' });
    expect(Number(s?.netPnl)).toBeCloseTo(Number(funds.realisedPnl) - Number(funds.charges), 2);
    expect(s?.initialRisk).toBe('750.00');
    expect(corpus.outcome).toHaveBeenCalledWith('int_1', expect.objectContaining({ netPnl: Number(s?.netPnl), win: true, holdMins: expect.any(Number) }), s?.closedAt);
    await svc.writeFor('user_A', p.id);
    expect(store.summaries).toHaveLength(1);
  });

  it('an active or unknown position has no summary; another user cannot write or read it', async () => {
    const h = lifecycleHarness();
    const store = new MemoryJournalStore();
    const svc = new CoreTradeSummaryService(h.positions.repo, h.ledger, store.summaryRepo, { entrySetup: jest.fn(), outcome: jest.fn() });
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(await svc.writeFor('user_A', p.id)).toBeNull();
    expect(await svc.writeFor('user_B', p.id)).toBeNull();
    expect(await svc.writeFor('user_A', 'nope')).toBeNull();
  });

  it('history: intentSeen, lastOpenedAt, and the last closed trade today (its net, or UNKNOWN when it cannot be summarised)', async () => {
    const { store, svc, p } = await closedTrade();
    expect(await svc.intentSeen('int_1')).toBe(true);
    expect(await svc.intentSeen('ci_other')).toBe(false);
    expect(await svc.lastOpenedAt('user_A', p.strategyId, '2885')).toEqual(expect.any(Date));
    expect(await svc.lastClosedNetToday('user_A', 'cs_none', '2885', new Date())).toBeNull();
    store.failWrites = true; // no summary yet, and none can be written now
    expect(await svc.lastClosedNetToday('user_A', p.strategyId, '2885', new Date())).toBe('UNKNOWN');
    store.failWrites = false; // repaired on read
    const net = await svc.lastClosedNetToday('user_A', p.strategyId, '2885', new Date());
    expect(typeof net).toBe('number');
    expect(store.summaries).toHaveLength(1);
  });

  it('positionClosed writes the summary (the lifecycle sink calls it)', async () => {
    const { store, svc, p } = await closedTrade();
    await svc.positionClosed('user_A', p.id);
    expect(store.summaries.map((s) => s.positionId)).toEqual([p.id]);
  });
});
