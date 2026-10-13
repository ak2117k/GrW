import { Prisma } from '@prisma/client';
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { balances, istDate, istDayStart, ZERO } from './ledger-math';
import { heldMargin } from './paper-ledger.service';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const INFY = { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null };

/** A closed RELIANCE trade (fill 500, exit at the 3 % target 515) and an open INFY position: real M3 ledger rows. */
async function tradedDay() {
  const h = lifecycleHarness();
  const closed = await h.lifecycle.openPosition(openRequest());
  await h.price(500); // fills the entry (the first fresh price after submission)
  await h.price(515); // the target is hit: the lifecycle places the exit
  await h.price(515); // fills the exit
  const open = await h.lifecycle.openPosition(openRequest({ instrument: INFY }, { intentId: 'int_2', symbol: 'INFY-EQ', underlying: 'INFY' }));
  await h.price(1500, { token: '1594', symbol: 'INFY-EQ' });
  return { h, closed, open };
}

describe('bounded ledger reads (ruling J19) equal the full-history ones', () => {
  it('istDayStart is IST midnight', () => {
    expect(istDayStart(new Date('2026-10-13T05:00:00.000Z')).toISOString()).toBe('2026-10-12T18:30:00.000Z');
  });

  it('funds from the aggregates equals balances() over every row, deployed margin per vehicle included', async () => {
    const { h } = await tradedDay();
    const all = h.paper.ledger.filter((r) => r.userId === 'user_A');
    const b = balances(all);
    const f = await h.ledger.funds('user_A');
    expect(f.cash).toBe(b.cash.toFixed(2));
    expect(f.blockedMargin).toBe(b.blockedMargin.toFixed(2));
    expect(f.realisedPnl).toBe(b.realisedPnl.toFixed(2));
    const vehicleOf = new Map(h.paper.orders.map((o) => [o.id, o.vehicle]));
    expect(f.deployedByVehicle.CASH_INTRADAY).toBe(heldMargin(all, (r) => r.orderId !== null && vehicleOf.get(r.orderId) === 'CASH_INTRADAY').toFixed(2));
  });

  it("dayStats and per-position P&L ignore rows before today's IST midnight", async () => {
    const { h } = await tradedDay();
    const before = await h.ledger.dayStats('user_A', new Date());
    const template = h.paper.ledger[h.paper.ledger.length - 1];
    h.paper.ledger.push({ ...template, id: 'led_old', type: 'REALISED_PNL', amount: new Prisma.Decimal('-999.00'), createdAt: new Date(istDayStart(new Date()).getTime() - 1) });
    const after = await h.ledger.dayStats('user_A', new Date());
    expect(after.netPnlToday.toFixed(2)).toBe(before.netPnlToday.toFixed(2));
    expect(after.entriesToday).toBe(2);
    // No MTF interest today, so the per-position nets (realised + charges) add up to the day's net.
    const perPosition = [...(await h.ledger.netPnlTodayByPosition('user_A', new Date())).values()].reduce((a, v) => a.plus(v), ZERO);
    expect(perPosition.toFixed(2)).toBe(before.netPnlToday.toFixed(2));
  });

  it("per-position reads: the position's ledger rows, its fills, margin per order, today's interest tokens", async () => {
    const { h, closed, open } = await tradedDay();
    const ids = h.ordersOf(closed.id).map((o) => o.id);
    const rows = await h.ledger.ledgerRowsForPosition('user_A', ids, '2885', istDate(new Date()), istDate(new Date()));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orderId !== null && ids.includes(r.orderId))).toBe(true);
    expect(rows.some((r) => r.type === 'REALISED_PNL')).toBe(true);
    expect((await h.ledger.fillsFor('user_A', ids)).reduce((n, f) => n + f.qty, 0)).toBe(200);
    const openIds = h.ordersOf(open.id).map((o) => o.id);
    const margin = await h.ledger.marginByOrder('user_A', [...ids, ...openIds]);
    // M3 books the exit's MARGIN_RELEASE on the exit order, so a closed position's margin nets to zero
    // across its orders, not per order (the entry order alone still shows its block).
    expect(ids.reduce((a, id) => a.plus(margin.get(id) ?? ZERO), ZERO).toFixed(2)).toBe('0.00');
    expect((margin.get(openIds[0]) ?? ZERO).gt(0)).toBe(true);
    expect(await h.ledger.interestTokensOn('user_A', istDate(new Date()))).toEqual(new Set());
  });
});
