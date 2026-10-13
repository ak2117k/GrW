import { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import type { CorePosition } from '../lifecycle/lifecycle.types';
import { cashPlan, mtfPlan, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import type { JournalRow } from './journal.types';
import { intradayFindings, nightlyFindings, reconBlockOf, type ReconSnapshot } from './recon-checks';

const ist = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00.000+05:30`);
const STUCK = 60_000;

function ord(id: string, over: Partial<CoreOrder> = {}): CoreOrder {
  return {
    id, userId: 'user_A', idempotencyKey: id, vehicle: 'CASH_INTRADAY', instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY', qty: 100, filledQty: 100, avgFillPrice: 500, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500, purpose: 'ENTRY',
    strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null, submittedAt: ist('10:00'), triggeredAt: null, updatedAt: ist('10:00'), ...over,
  };
}

const openPos = (over: Partial<CorePosition> = {}) => positionFor(cashPlan(), { status: 'OPEN', entryFilledQty: 100, exitFilledQty: 0, openQty: 100, updatedAt: ist('10:00'), ...over });

function snap(positions: CorePosition[], orders: CoreOrder[], over: Partial<ReconSnapshot> = {}): ReconSnapshot {
  const ordersByPosition = new Map<string, CoreOrder[]>();
  for (const o of orders) ordersByPosition.set(o.positionId as string, [...(ordersByPosition.get(o.positionId as string) ?? []), o]);
  return {
    now: ist('11:00'), positions, ordersByPosition,
    fillQtyByOrder: new Map(orders.map((o) => [o.id, o.filledQty])),
    lastFillAtByOrder: new Map(),
    marginByOrder: new Map(), summarised: new Set(), interestTokensToday: new Set(), stuckAfterMs: STUCK, ...over,
  };
}

describe('intradayFindings (spec §8.3, J17)', () => {
  it('a consistent open position has no finding', () => {
    expect(intradayFindings(snap([openPos()], [ord('o1')]))).toEqual([]);
  });

  it("fills that do not sum to an order's filledQty", () => {
    const s = snap([openPos()], [ord('o1')], { fillQtyByOrder: new Map([['o1', 60]]) });
    expect(intradayFindings(s)).toEqual([expect.objectContaining({ check: 'FILLS_VS_ORDER', positionId: 'pos_1', orderId: 'o1', strategyId: 'cs_ungated', repair: null, fingerprint: 'FILLS_VS_ORDER:pos_1:o1' })]);
  });

  it('a position row that disagrees with its orders — only once the orders have been quiet past the stuck threshold', () => {
    const p = openPos({ entryFilledQty: 80, openQty: 80 });
    expect(intradayFindings(snap([p], [ord('o1', { updatedAt: ist('10:59') })], { now: new Date(ist('10:59').getTime() + 30_000) }))).toEqual([]);
    expect(intradayFindings(snap([p], [ord('o1')]))).toEqual([expect.objectContaining({ check: 'POSITION_VS_ORDERS' })]);
  });

  it('a stuck entry is cancelled; a stuck exit is only flagged (exits are never cancelled)', () => {
    const entry = ord('o1', { state: 'OPEN', filledQty: 0, avgFillPrice: null });
    const pending = positionFor(cashPlan(), { status: 'PENDING_ENTRY', entryFilledQty: 0, openQty: 0, updatedAt: ist('10:00') });
    expect(intradayFindings(snap([pending], [entry]))).toEqual([expect.objectContaining({ check: 'STUCK_ORDER', orderId: 'o1', repair: 'CANCEL_ENTRY' })]);
    const exit = ord('o2', { purpose: 'EXIT', side: 'SELL', state: 'NEW', filledQty: 0, avgFillPrice: null });
    const exiting = openPos({ status: 'EXITING', updatedAt: ist('10:00') });
    const found = intradayFindings(snap([exiting], [ord('o1'), exit]));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'STUCK_ORDER', orderId: 'o2', repair: null }), expect.objectContaining({ check: 'STUCK_EXITING', positionId: 'pos_1' })]));
  });

  it('a closed position without a summary is a WRITE_SUMMARY repair', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'TARGET' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL', avgFillPrice: 515 })];
    expect(intradayFindings(snap([closed], orders))).toEqual([expect.objectContaining({ check: 'SUMMARY_MISSING', repair: 'WRITE_SUMMARY' })]);
    expect(intradayFindings(snap([closed], orders, { summarised: new Set(['pos_1']) }))).toEqual([]);
  });
});

describe('nightlyFindings (15:45 IST)', () => {
  const at = ist('15:45');

  it('an intraday position still open after its square-off time', () => {
    expect(nightlyFindings(snap([openPos()], [ord('o1')], { now: at }))).toEqual([expect.objectContaining({ check: 'INTRADAY_OPEN_AFTER_SQUARE_OFF' })]);
  });

  it('an open MTF holding without an interest row today; with one it is clean', () => {
    const mtf = positionFor(mtfPlan(), { status: 'OPEN', entryFilledQty: 100, openQty: 100, updatedAt: ist('10:00') });
    const orders = [ord('o1', { vehicle: 'MTF' })];
    expect(nightlyFindings(snap([mtf], orders, { now: at }))).toEqual([expect.objectContaining({ check: 'MTF_INTEREST_MISSING' })]);
    expect(nightlyFindings(snap([mtf], orders, { now: at, interestTokensToday: new Set(['2885']) }))).toEqual([]);
  });

  // Stream A finding: M3 books the exit's MARGIN_RELEASE on the EXIT order, so a cleanly closed
  // position reads +X on its entry order and −X on its exit order. The check sums per position.
  it('margin left on a closed position: its orders sum to a non-zero margin (reported per position)', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'STOP' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL' })];
    const s = snap([closed], orders, { now: at, summarised: new Set(['pos_1']), marginByOrder: new Map([['o1', new Prisma.Decimal('10000.00')], ['o2', new Prisma.Decimal('-9987.50')]]) });
    expect(nightlyFindings(s)).toEqual([
      expect.objectContaining({ check: 'MARGIN_LEFT_ON_CLOSED', positionId: 'pos_1', orderId: null, fingerprint: 'MARGIN_LEFT_ON_CLOSED:pos_1:-', detail: expect.stringContaining('12.50') }),
    ]);
  });

  it('a cleanly closed position (+X on the entry order, −X on the exit order, summarised) raises no finding', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'TARGET' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL', avgFillPrice: 515 })];
    const s = snap([closed], orders, { now: at, summarised: new Set(['pos_1']), marginByOrder: new Map([['o1', new Prisma.Decimal('10000.00')], ['o2', new Prisma.Decimal('-10000.00')]]) });
    expect(nightlyFindings(s)).toEqual([]);
    expect(intradayFindings(s)).toEqual([]);
  });

  it('a partially exited then closed position nets to zero across all its exit orders: no finding', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'TARGET' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL', qty: 50, filledQty: 50 }), ord('o3', { purpose: 'EXIT', side: 'SELL', qty: 50, filledQty: 50 })];
    const marginByOrder = new Map([['o1', new Prisma.Decimal('10000')], ['o2', new Prisma.Decimal('-5000')], ['o3', new Prisma.Decimal('-5000')]]);
    expect(nightlyFindings(snap([closed], orders, { now: at, summarised: new Set(['pos_1']), marginByOrder }))).toEqual([]);
  });

  it('a cancelled position whose entry still holds margin is flagged; one that released it is clean', () => {
    const cancelled = positionFor(cashPlan(), { status: 'CANCELLED', entryFilledQty: 0, openQty: 0, updatedAt: ist('10:00') });
    const orders = [ord('o1', { state: 'CANCELLED', filledQty: 0, avgFillPrice: null })];
    expect(nightlyFindings(snap([cancelled], orders, { now: at, marginByOrder: new Map([['o1', new Prisma.Decimal('500')]]) }))).toEqual([
      expect.objectContaining({ check: 'MARGIN_LEFT_ON_CLOSED', positionId: 'pos_1', orderId: null }),
    ]);
    expect(nightlyFindings(snap([cancelled], orders, { now: at, marginByOrder: new Map([['o1', new Prisma.Decimal(0)]]) }))).toEqual([]);
  });
});

describe('reconBlockOf (O10)', () => {
  const row = (strategyId: string | null): JournalRow => ({
    id: 'm', userId: 'user_A', type: 'RECON_MISMATCH', positionId: null, strategyId, strategyVersionId: null, intentId: null, symbol: null,
    payload: {}, priceUsed: null, priceAgeMs: null, dedupeKey: null, istDay: '2026-10-13', createdAt: ist('11:00'),
  });

  it('no rows block nothing; strategy rows block those strategies; a user-wide row blocks all', () => {
    expect(reconBlockOf([])).toEqual({ all: false, strategyIds: [] });
    expect(reconBlockOf([row('cs_a'), row('cs_b'), row('cs_a')])).toEqual({ all: false, strategyIds: ['cs_a', 'cs_b'] });
    expect(reconBlockOf([row('cs_a'), row(null)])).toEqual({ all: true, strategyIds: ['cs_a'] });
  });
});

describe('FILLS_VS_ORDER age guard (review fix 3: a fill landing between the order read and the fills read)', () => {
  it('no finding while the order or its newest fill is younger than the stuck threshold; flagged once both are quiet', () => {
    // The snapshot read the order (still OPEN, 0 filled) before its fill committed; the fills read saw the fill.
    const racing = ord('o1', { state: 'OPEN', filledQty: 0, avgFillPrice: null, submittedAt: ist('10:59'), updatedAt: ist('10:59') });
    const p = positionFor(cashPlan(), { status: 'PENDING_ENTRY', entryFilledQty: 0, openQty: 0, updatedAt: ist('10:59') });
    const fresh = snap([p], [racing], { fillQtyByOrder: new Map([['o1', 100]]), lastFillAtByOrder: new Map([['o1', ist('11:00')]]) });
    expect(intradayFindings(fresh).filter((f) => f.check === 'FILLS_VS_ORDER')).toEqual([]);
    // An old order whose fill is brand new: still in motion, not a mismatch.
    const oldOrder = ord('o1', { filledQty: 0 });
    const s2 = snap([openPos()], [oldOrder], { fillQtyByOrder: new Map([['o1', 100]]), lastFillAtByOrder: new Map([['o1', new Date(ist('11:00').getTime() - 1_000)]]) });
    expect(intradayFindings(s2).filter((f) => f.check === 'FILLS_VS_ORDER')).toEqual([]);
    // Both quiet past the threshold: a real mismatch.
    const s3 = snap([openPos()], [oldOrder], { fillQtyByOrder: new Map([['o1', 100]]), lastFillAtByOrder: new Map([['o1', ist('10:00')]]) });
    expect(intradayFindings(s3)).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'FILLS_VS_ORDER', orderId: 'o1' })]));
  });
});
