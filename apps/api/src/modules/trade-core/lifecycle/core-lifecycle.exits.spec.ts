import type { Price } from '../../market-hub/hub.types';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const exitsOf = (h: ReturnType<typeof lifecycleHarness>, id: string) => h.ordersOf(id).filter((o) => o.purpose === 'EXIT');
const ist = (local: string) => new Date(`${local}+05:30`);

describe('CoreLifecycleService: exits (spec §7.2–§7.4)', () => {
  it('stop: one MARKET exit keyed <intentId>:exit:1; the next price closes it as STOP and lets it go', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(492);
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.type, o.side, o.qty, o.state])).toEqual([['int_1:exit:1', 'MARKET', 'SELL', 100, 'OPEN']]);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'STOP', exitSeq: 1 });
    await h.price(491.5);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, exitReason: 'STOP', lowWater: 492 });
    expect(h.lifecycle.activeCount()).toBe(0);
    expect(h.hub.unwatches.map((u) => u.owner)).toContain(`core:${p.id}`);
    expect(h.sink.types(p.id)).toEqual(['POSITION_STATE', 'POSITION_STATE', 'EXIT_DECIDED', 'POSITION_STATE', 'POSITION_STATE']);
  });

  it('target: the target price exits everything as TARGET', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(515);
    await h.price(515);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TARGET', highWater: 515 });
  });

  it('Adaptive-shaped: half at +1 %, then the ATR trail exits the rest as TRAIL', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest({ atr: 5 }, { strategyId: 'cs_adaptive', strategyVersionId: 'csv_adaptive_v1', stopPrice: 494 }));
    await h.price(500); // OPEN: stop 494, partial 505 × 50, target 510
    await h.price(505); // partial decided: SELL 50 (exit:1); the trail arms
    await h.price(505); // the partial fills; trail from 505 with ATR 5 → stop 500
    await h.lifecycle.sweep(Date.now()); // flushes the coalesced marks (ruling L11)
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'PARTIAL', openQty: 50, partialDone: true, trailActive: true, stopPrice: 500 });
    await h.price(508); // stop 503
    await h.price(502.5); // crosses 503: TRAIL, exit:2 for the 50 left
    await h.price(502.5);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TRAIL', exitFilledQty: 100 });
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.qty])).toEqual([
      ['int_1:exit:1', 50],
      ['int_1:exit:2', 50],
    ]);
    expect(h.sink.events.filter((e) => e.type === 'STOP_MOVED').map((e) => e.payload.to)).toEqual([500, 503]);
  });

  it('square-off: at the effective time the position exits even with no fresh price', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    jest.setSystemTime(ist('2026-10-12T15:15:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'SQUARE_OFF' });
    expect(exitsOf(h, p.id)[0].refPrice).toBe(500);
    await h.price(499);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('a live squareOffTime tightened after entry applies to the open position (O4)', async () => {
    const h = lifecycleHarness({ liveLimits: () => limitsFixture({ 'squareOffTime@CASH_INTRADAY': '14:00' }) });
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    jest.setSystemTime(ist('2026-10-12T14:00:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'SQUARE_OFF' });
  });

  it('a rejected exit is re-placed with the next sequence once the session is open, never twice at once (Review Focus 1)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(492); // STOP → exit:1, waiting for a price
    h.advance(30_001);
    await h.matcher.sweep(Date.now()); // no price for 30 s: exit:1 is REJECTED
    await h.settle();
    expect(h.positions.rows[0].status).toBe('EXITING');
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.state])).toEqual([
      ['int_1:exit:1', 'REJECTED'],
      ['int_1:exit:2', 'OPEN'],
    ]);
    await h.price(491);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
  });

  it('a closed session decides nothing and flags no blind position (Review Focus 4, ruling L9)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.session.open = false;
    h.killOn.add('user_A');
    h.advance(120_000);
    await h.price(480);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id)).toEqual([]);
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', blindSince: null });
  });

  it('blind: no fresh price for blindAfterMs flags BLIND once; a fresh price clears it', async () => {
    const h = lifecycleHarness({ blindAfterMs: 30_000 });
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.lifecycle.sweep(Date.now());
    h.advance(30_001);
    await h.lifecycle.sweep(Date.now());
    h.advance(1_000);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0].blindSince).not.toBeNull();
    await h.price(501);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0].blindSince).toBeNull();
    expect(h.sink.events.filter((e) => e.type === 'BLIND').map((e) => e.payload.blind)).toEqual([true, false]);
  });

  it('a push and a sweep at once place one exit (Review Focus 5)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.advance(10);
    const crash: Price = { ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, ltp: 490, at: Date.now(), source: 'ws' };
    h.hub.setFresh(crash);
    await Promise.all([h.lifecycle.onPrice(h.hub, crash, Date.now()), h.lifecycle.sweep(Date.now())]);
    await h.settle();
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });

  it('the kill switch (reader) exits at priority 1 from the sweep, the safety net behind the cascade', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.killOn.add('user_A');
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });
});
