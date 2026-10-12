import { NotFoundException } from '@nestjs/common';
import { cashPlan, NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const exitsOf = (h: ReturnType<typeof lifecycleHarness>, id: string) => h.ordersOf(id).filter((o) => o.purpose === 'EXIT');
const ist = (local: string) => new Date(`${local}+05:30`);

describe('CoreLifecycleService: recovery (spec §7.6)', () => {
  it('a recreated service reloads active positions, re-watches them, and a stop crossed while down exits as RECOVERY_STOP', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const svc = h.restart();
    h.advance(10);
    h.hub.setFresh({ ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, ltp: 480, at: Date.now(), source: 'quote' }); // moved while down
    await svc.sweep(Date.now());
    await h.settle();
    expect(svc.activeCount()).toBe(1);
    expect(h.hub.watches.filter((w) => w.owner === `core:${p.id}`)).toHaveLength(2);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'RECOVERY_STOP' });
    expect(h.sink.types(p.id)).toContain('RECOVERY_STOP');
    await h.price(479);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('recovery re-places a decided exit with the same idempotency key, once (Review Focus 2)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    // The crash: the decision and its sequence are persisted, the order never placed.
    await h.positions.repo.update('user_A', p.id, h.positions.rows[0].version, { status: 'EXITING', exitReason: 'STOP', exitSeq: 1 });
    const svc = h.restart();
    await svc.sweep(Date.now());
    await h.settle();
    await svc.sweep(Date.now());
    h.advance(6_000);
    await svc.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id).map((o) => o.idempotencyKey)).toEqual(['int_1:exit:1']);
    await h.price(499);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
  });

  it('a kill switch during the first sweep joins its recovery: one scan, one exit (review fix 1)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const svc = h.restart();
    const scans = jest.spyOn(h.positions.repo, 'listActive');
    const [, r] = await Promise.all([svc.sweep(Date.now()), svc.exitAll('user_A', 'KILL_SWITCH', 'stop')]);
    await h.settle();
    expect(scans).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ exitsRequested: 1 });
    expect(svc.activeCount()).toBe(1);
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });

  it('with nothing held the sweep reads no settings, but keeps retrying a failed boot reload (review fix 4)', async () => {
    const h = lifecycleHarness();
    const settings = jest.spyOn(h.defaults, 'settings');
    const scans = jest.spyOn(h.positions.repo, 'listActive').mockRejectedValueOnce(new Error('db down'));
    await h.lifecycle.sweep(Date.now()); // the reload fails
    await h.lifecycle.sweep(Date.now()); // retried: loaded, nothing active
    h.advance(1_000);
    await h.lifecycle.sweep(Date.now());
    expect(scans).toHaveBeenCalledTimes(2);
    expect(settings).not.toHaveBeenCalled();
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.lifecycle.sweep(Date.now());
    expect(settings).toHaveBeenCalled();
  });

  it('a position whose entry was never placed (crash in between) is CANCELLED on recovery, never entered late', async () => {
    const h = lifecycleHarness();
    await h.positions.repo.createIfNoActive({
      userId: 'user_A', intentId: 'int_ghost', strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1', vehicle: 'CASH_INTRADAY',
      instrument: openRequest().instrument, underlying: 'RELIANCE', side: 'BUY', direction: 'LONG', requestedQty: 100, plan: cashPlan(),
    });
    const svc = h.restart();
    await svc.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows.find((x) => x.intentId === 'int_ghost')).toMatchObject({ status: 'CANCELLED' });
    expect(h.paper.orders).toEqual([]);
  });
});

describe('CoreLifecycleService: exitAll (kill switch / daily loss) and guard rails', () => {
  it('kill switch on a partly filled entry cancels the remainder and exits the filled part (Review Focus 3)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500, { qty: 40 }); // a book of 40: the entry fills 40 of 100
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', entryFilledQty: 40 });
    expect(await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop everything')).toEqual({ exitsRequested: 1 });
    await h.settle();
    const orders = h.ordersOf(p.id);
    expect(orders.find((o) => o.purpose === 'ENTRY')).toMatchObject({ state: 'CANCELLED', filledQty: 40 });
    expect(exitsOf(h, p.id).map((o) => o.qty)).toEqual([40]);
    await h.price(499);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH', entryFilledQty: 40, exitFilledQty: 40 });
  });

  it('kill switch on an unfilled entry cancels it and the position is CANCELLED, with no exit order', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop');
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect(h.ordersOf(p.id).map((o) => [o.purpose, o.state])).toEqual([['ENTRY', 'CANCELLED']]);
  });

  it('a kill switch while a target exit is pending re-labels the reason and adds no order', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(515); // TARGET: exit:1 pending
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop');
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });

  it('exitAll counts only real exits: an EXITING write that loses the race is not reported as requested (review fix 3)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    jest.spyOn(h.positions.repo, 'update').mockResolvedValueOnce(null); // a concurrent writer wins the EXITING write
    expect(await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop')).toEqual({ exitsRequested: 0 });
    expect(exitsOf(h, p.id)).toEqual([]);
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN' });
  });

  it("exitAll touches only the user's own positions", async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    await h.lifecycle.exitAll('user_A', 'DAILY_LOSS', 'limit reached');
    await h.settle();
    expect(h.positions.rows.map((x) => [x.userId, x.status, x.exitReason])).toEqual([
      ['user_A', 'EXITING', 'DAILY_LOSS'],
      ['user_B', 'OPEN', null],
    ]);
  });

  it('MTF overnight: nothing while closed; the first price of the next session past the stop is a GAP_STOP (Review Focus 4)', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest({}, { strategyId: 'cs_mtf', strategyVersionId: 'csv_mtf_v1', vehicle: 'MTF', mtfLeverage: 2 }));
    await h.price(500); // OPEN, stop 492.5
    h.session.open = false;
    jest.setSystemTime(ist('2026-10-12T20:00:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', blindSince: null });
    jest.setSystemTime(ist('2026-10-13T09:15:05.000'));
    h.session.open = true;
    await h.price(480);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'GAP_STOP' });
    await h.price(481);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('guard rails: proposeStop accepts only a tighter stop; requestExit exits as GUARD_RAIL; another user gets a 404', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(await h.lifecycle.proposeStop('user_A', p.id, 490, 'sentinel')).toEqual({ accepted: false, stopPrice: 492.5 });
    expect(await h.lifecycle.proposeStop('user_A', p.id, 495, 'sentinel')).toEqual({ accepted: true, stopPrice: 495 });
    expect(h.positions.rows[0].stopPrice).toBe(495);
    await expect(h.lifecycle.proposeStop('user_B', p.id, 498, 'x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.lifecycle.requestExit('user_B', p.id, 'MANUAL', 'x')).rejects.toBeInstanceOf(NotFoundException);
    await h.lifecycle.requestExit('user_A', p.id, 'GUARD_RAIL', 'thesis invalidated');
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'GUARD_RAIL' });
  });
});
