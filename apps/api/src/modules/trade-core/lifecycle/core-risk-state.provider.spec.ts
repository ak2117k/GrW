import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { PaperLedgerService, type PlaceContext } from '../execution/paper-ledger.service';
import { fakeDefaults, MemoryPaperStore } from '../execution/testing/memory-paper-store';
import { cashBuy } from '../execution/testing/paper-fixtures';
import { checkRisk } from '../risk-wall/risk-wall';
import { ctxFixture, intentFixture } from '../risk-wall/testing/risk-fixtures';
import { CoreRiskStateProvider, markToMarket } from './core-risk-state.provider';
import { cashPlan, NOW } from './testing/lifecycle-fixtures';
import { MemoryPositionStore } from './testing/memory-position-store';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults());
  const positions = new MemoryPositionStore(() => NOW);
  const marks = new Map<string, { ltp: number; at: number }>();
  const provider = new CoreRiskStateProvider(ledger, positions.repo, { mark: (id) => marks.get(id) ?? null });
  return { store, ledger, positions, marks, provider };
}

/** A filled cash BUY of 100 @ 500 under a core position (the ledger and the position agree). */
async function openCash(s: ReturnType<typeof setup>, userId = 'user_A', intentId = 'int_1', fill = true) {
  const p = await s.positions.repo.createIfNoActive({
    userId, intentId, strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1', vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    underlying: 'RELIANCE', side: 'BUY', direction: 'LONG', requestedQty: 100, plan: cashPlan(),
  });
  const entry = (await s.ledger.place(cashBuy({ userId, idempotencyKey: `${intentId}:entry`, positionId: p.id }), OPEN, NOW)).order;
  if (!fill) return p;
  await s.ledger.applyFill(userId, entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
  const opened = await s.positions.repo.update(userId, p.id, 0, { status: 'OPEN', entryFilledQty: 100, entryAvgPrice: 500, openedAt: NOW });
  if (!opened) throw new Error('fixture update lost');
  return opened;
}

describe('CoreRiskStateProvider (RISK_STATE_PROVIDER, M2 notes for M4)', () => {
  it('reports each active position with its strategy, exposure underlying and state; priced only with a fresh mark', async () => {
    const s = setup();
    const p = await openCash(s);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() - 1_000 });
    expect((await s.provider.liveState('user_A', NOW)).openPositions).toEqual([
      { positionId: p.id, strategyId: 'cs_ungated', vehicle: 'CASH_INTRADAY', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', direction: 'LONG', state: 'OPEN', priced: true },
    ]);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() - 16_000 });
    const stale = await s.provider.liveState('user_A', NOW);
    expect(stale.openPositions[0].priced).toBe(false);
    expect(stale.openPnl).toBeNull();
    s.marks.delete(p.id);
    expect((await s.provider.liveState('user_A', NOW)).openPositions[0].priced).toBe(false);
  });

  it("openPnl is the mark net of the exit leg's charges; the strategy's P&L adds today's realised (net) of its positions", async () => {
    const s = setup();
    const p = await openCash(s);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() });
    const exitLeg = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'SELL', price: 510, qty: 100 }).total;
    const expected = Math.round((1000 - exitLeg) * 100) / 100;
    expect(markToMarket(p, 510)).toBe(expected);
    const state = await s.provider.liveState('user_A', NOW);
    expect(state.openPnl).toBe(expected);
    const entryNet = (await s.ledger.netPnlTodayByPosition('user_A', NOW)).get(p.id)?.toNumber() ?? 0;
    expect(entryNet).toBeLessThan(0); // the entry's charges
    expect(state.pnlTodayByStrategy).toEqual({ cs_ungated: Math.round((entryNet + expected) * 100) / 100 });
    expect(state.tradesToday).toBe(1);
    expect(state.deployedCapital.CASH_INTRADAY).toBe(10000);
    expect(state.dailyLossLatched).toBe(false);
  });

  it('a pending entry with nothing filled is priced, with no open P&L', async () => {
    const s = setup();
    await openCash(s, 'user_A', 'int_1', false);
    const state = await s.provider.liveState('user_A', NOW);
    expect(state.openPositions.map((x) => [x.state, x.priced])).toEqual([['PENDING_ENTRY', true]]);
    expect(state.openPnl).toBe(0);
  });

  it("reports only the caller's positions", async () => {
    const s = setup();
    await openCash(s, 'user_A', 'int_a');
    const b = await openCash(s, 'user_B', 'int_b');
    s.marks.set(b.id, { ltp: 500, at: NOW.getTime() });
    expect((await s.provider.liveState('user_B', NOW)).openPositions.map((x) => x.positionId)).toEqual([b.id]);
  });

  it('with fresh marks the Risk Wall can ALLOW an entry; an unpriced position makes it reject', async () => {
    const s = setup();
    const p = await openCash(s);
    const tcs = intentFixture({ intentId: 'int_tcs', symbol: 'TCS', underlying: 'TCS' });
    expect(checkRisk(tcs, ctxFixture({ state: await s.provider.liveState('user_A', NOW) })).reasons.map((r) => r.code)).toContain('UNPRICED_POSITION');
    s.marks.set(p.id, { ltp: 501, at: NOW.getTime() });
    expect(checkRisk(tcs, ctxFixture({ state: await s.provider.liveState('user_A', NOW) })).verdict).toBe('ALLOW');
  });

  it("drift D12: a RELIANCE-EQ position reports the intent's underlying RELIANCE, so a short RELIANCE entry is a conflict", async () => {
    const s = setup();
    const p = await openCash(s);
    s.marks.set(p.id, { ltp: 501, at: NOW.getTime() });
    const state = await s.provider.liveState('user_A', NOW);
    expect(state.openPositions[0]).toMatchObject({ symbol: 'RELIANCE-EQ', underlying: 'RELIANCE' });
    const shortReliance = intentFixture({ intentId: 'int_short', symbol: 'RELIANCE', underlying: 'RELIANCE', side: 'SELL', stopPrice: 2537.5 });
    expect(checkRisk(shortReliance, ctxFixture({ state })).reasons.map((r) => r.code)).toContain('CONFLICT_OPPOSITE_DIRECTION');
  });

  it('a ledger read that fails throws (RiskWallService turns it into CONTEXT_UNAVAILABLE)', async () => {
    const s = setup();
    jest.spyOn(s.ledger, 'funds').mockRejectedValueOnce(new Error('db down'));
    await expect(s.provider.liveState('user_A', NOW)).rejects.toThrow('db down');
  });
});
