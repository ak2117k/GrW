// FLOOR_BROKER_SL live path: SentinelExitExecutor.syncFloorStops and its overlap with exits.
import { SentinelExitExecutor, type FloorStopIntent } from './sentinel-exit-executor.service';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { floorStopTag } from '../domain/floor-broker-sl';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';
import * as opsAlert from '../../../common/utils/ops-alert';

const NOW = new Date('2026-11-06T05:00:00Z');
const EXIT = parseAutoExitConfig({
  AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true',
});
const CFG = { limitTicks: 3, modifyMinSec: 15, exit: EXIT };
const env = (data: unknown) => ({ status: true, data });
const pos = (netqty = '130', ltp = '186') => ({
  tradingsymbol: 'NIFTY09NOV2624650CE', symboltoken: '40009', exchange: 'NFO', producttype: 'CARRYFORWARD', netqty, ltp,
});
const ourStop = (over: Record<string, unknown> = {}) => ({
  orderid: 'SL1', ordertag: floorStopTag('t1'), exchange: 'NFO', symboltoken: '40009', tradingsymbol: 'NIFTY09NOV2624650CE',
  status: 'trigger pending', variety: 'STOPLOSS', ordertype: 'STOPLOSS_LIMIT', transactiontype: 'SELL', producttype: 'CARRYFORWARD',
  quantity: '130', triggerprice: '170', price: '169.85', ...over,
});
const intent = (over: Partial<FloorStopIntent> = {}): FloorStopIntent => ({
  trackerId: 't1', symbol: 'NIFTY09NOV2624650CE', exchange: 'NFO', token: '40009', trackerQty: 130, entryTime: new Date('2026-11-06T04:39:00Z'),
  lotSize: 65, tick: 0.05, floor: 180.74, eligible: { ok: true }, ...over,
});

function harness(o: { positions?: unknown[]; books?: unknown[]; inFlight?: boolean; place?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const q = <T>(xs: T[]) => { const a = [...xs]; return () => (a.length > 1 ? a.shift()! : a[0]); };
  const nextPos = q(o.positions ?? [env([pos()])]);
  const nextBook = q(o.books ?? [env([])]);
  const session = {
    getPositionsEnvelope: jest.fn(async () => { calls.push('positions'); return nextPos(); }),
    getOrderBookEnvelope: jest.fn(async () => { calls.push('book'); return nextBook(); }),
    placeOrderClassified: jest.fn(async (ord: any, tag: string) => {
      calls.push(`place:${ord.orderType}:${tag}`);
      return o.place ? o.place() : { status: 'PLACED', orderId: 'SL9', message: 'SUCCESS' };
    }),
    cancelOrderClassified: jest.fn(async (variety: string, id: string) => { calls.push(`cancel:${variety}:${id}`); return { status: 'ACCEPTED', message: 'SUCCESS' }; }),
    modifyOrderClassified: jest.fn(async (m: any) => { calls.push(`modify:${m.orderId}:${m.triggerPrice}`); return { status: 'ACCEPTED', message: 'SUCCESS' }; }),
  };
  const repo = {
    claim: jest.fn(async () => 'row1'),
    update: jest.fn(async () => undefined),
    countCountedSince: jest.fn(async () => 0),
    hasInFlight: jest.fn(async () => o.inFlight ?? false),
  };
  const prisma = {
    tradeTracker: { findUnique: jest.fn(async () => ({ id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NFO', token: '40009', symbol: 'NIFTY09NOV2624650CE', qty: 130 })) },
    instrument: { findFirst: jest.fn(async () => ({ tickSize: 5, lotSize: 65 })) },
  };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any) => fn(session, 'user-feed')), reloginOwner: jest.fn() };
  const gate = { enabled: () => false, load: jest.fn(), decide: jest.fn() };
  const clock = { isOpen: () => true, minutesToClose: () => 200, tradingWindow: () => null };
  const sleep = jest.fn(async () => undefined);
  const ex = new SentinelExitExecutor(repo as never, prisma as never, sessions as never, clock as never, sleep, gate as never);
  return { ex, session, repo, sessions, calls, sleep };
}

describe('syncFloorStops (FLOOR_BROKER_SL live)', () => {
  it('places a SELL STOPLOSS-LIMIT at the armed floor: trigger ceiled to the tick, limit 3 ticks under, the broker qty / product, our tag', async () => {
    const h = harness();
    const [r] = await h.ex.syncFloorStops('owner', [intent()], CFG, NOW);
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', orderType: 'STOPLOSS', variety: 'STOPLOSS', triggerPrice: 180.75, price: 180.6, quantity: 130, positionType: 'CARRYFORWARD', token: '40009', exchange: 'NFO' }),
      floorStopTag('t1'),
    );
    expect(r).toMatchObject({ action: 'PLACE', trigger: 180.75, limit: 180.6, quantity: 130, orderId: 'SL9' });
    // The answer is re-read from the book (never trusted alone).
    expect(h.calls.filter((c) => c === 'book').length).toBeGreaterThanOrEqual(2);
  });

  it('trails a resting stop UP with a modify of the same order', async () => {
    const h = harness({ books: [env([ourStop()])] });
    const [r] = await h.ex.syncFloorStops('owner', [intent()], CFG, NOW);
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(h.session.modifyOrderClassified).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'SL1', variety: 'STOPLOSS', orderType: 'STOPLOSS', triggerPrice: 180.75, price: 180.6, quantity: 130 }));
    expect(r).toMatchObject({ action: 'MODIFY', prevTrigger: 170, trigger: 180.75 });
  });

  it('never lowers it, and rate-limits a second modify', async () => {
    const h = harness({ books: [env([ourStop({ triggerprice: '185', price: '184.85' })])] });
    expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'KEEP', reason: 'NO_IMPROVEMENT' });
    const h2 = harness({ books: [env([ourStop()])] });
    await h2.ex.syncFloorStops('owner', [intent({ floor: 175 })], CFG, NOW);
    expect(h2.session.modifyOrderClassified).toHaveBeenCalledTimes(1);
    const again = await h2.ex.syncFloorStops('owner', [intent()], CFG, new Date(NOW.getTime() + 5_000));
    expect(again[0]).toMatchObject({ action: 'KEEP', reason: 'RATE_LIMITED' });
    expect(h2.session.modifyOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('a stop resting on a FLAT position is cancelled — even while an exit is recorded in flight', async () => {
    const h = harness({ positions: [env([pos('0')])], books: [env([ourStop()])], inFlight: true });
    const [r] = await h.ex.syncFloorStops('owner', [intent({ eligible: { ok: false, reason: 'POSITION_CLOSED' } })], CFG, NOW);
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('STOPLOSS', 'SL1');
    expect(r).toMatchObject({ action: 'CANCEL' });
  });

  it('a disarmed floor cancels our stop', async () => {
    const h = harness({ books: [env([ourStop()])] });
    const [r] = await h.ex.syncFloorStops('owner', [intent({ eligible: { ok: false, reason: 'FLOOR_DISARMED' } })], CFG, NOW);
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('STOPLOSS', 'SL1');
    expect(r).toMatchObject({ action: 'CANCEL', reason: 'FLOOR_DISARMED' });
  });

  it('any OTHER open order on the contract: ours is cancelled, none is placed (two stops = a double sell)', async () => {
    const owner = { ...ourStop({ orderid: 'OWN1', ordertag: '' }) };
    const h = harness({ books: [env([owner, ourStop()])] });
    expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('STOPLOSS', 'SL1');
    const h2 = harness({ books: [env([owner])] });
    expect((await h2.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'NONE', reason: 'OTHER_OPEN_ORDER' });
    expect(h2.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('hands off entirely while an exit is in flight / of unknown fate, or an exit order of ours is on the book', async () => {
    const h = harness({ books: [env([ourStop()])], inFlight: true });
    expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'KEEP', reason: 'EXIT_IN_FLIGHT' });
    const exitOrder = { orderid: 'X1', ordertag: 'axMabc', exchange: 'NFO', symboltoken: '40009', status: 'open', transactiontype: 'SELL' };
    const h2 = harness({ books: [env([exitOrder])] });
    expect((await h2.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'KEEP', reason: 'EXIT_ORDER_ON_BOOK' });
    for (const x of [h, h2]) {
      expect(x.session.placeOrderClassified).not.toHaveBeenCalled();
      expect(x.session.cancelOrderClassified).not.toHaveBeenCalled();
      expect(x.session.modifyOrderClassified).not.toHaveBeenCalled();
    }
  });

  it('does not place when the price is already through the floor (the polling exit owns it)', async () => {
    const h = harness({ positions: [env([pos('130', '180.7')])] });
    expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'NONE', reason: 'NOT_PLACEABLE' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('an unanswered read (SDK {} / status:false) writes nothing', async () => {
    for (const bad of [{}, { status: false, message: 'x' }]) {
      const h = harness({ books: [bad] });
      expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'ERROR', reason: 'BROKER_READ' });
      expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    }
  });

  it('a filled stop is reported FILLED and nothing is re-placed', async () => {
    const h = harness({ positions: [env([pos('0')])], books: [env([ourStop({ status: 'complete', averageprice: '180.7', filledshares: '130' })])] });
    expect((await h.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'FILLED', fillPrice: 180.7 });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });
});

describe('FLOOR_BROKER_SL_AT=ceiling and an owner order resting on the contract (EXIT_CANCEL_OWNER_ORDERS)', () => {
  const CEIL = { ...CFG, at: 'ceiling' as const };
  const ownerSell = { orderid: 'OWN1', ordertag: '', exchange: 'NFO', symboltoken: '40009', status: 'open', variety: 'NORMAL', ordertype: 'LIMIT', transactiontype: 'SELL', producttype: 'CARRYFORWARD', quantity: '130', price: '220' };
  const ceilingStop = () => ourStop({ triggerprice: '120', price: '119.85' });
  const ceilingIntent = () => intent({ floor: 120 });

  it('an owner exit-side order no longer CANCELS a resting ceiling stop (KEEP)', async () => {
    const h = harness({ books: [env([ownerSell, ceilingStop()])] });
    const [r] = await h.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW);
    expect(r).toMatchObject({ action: 'KEEP', reason: 'OWNER_ORDER_RESTING', trigger: 120 });
    expect(h.session.cancelOrderClassified).not.toHaveBeenCalled();
    expect(h.session.modifyOrderClassified).not.toHaveBeenCalled();
  });

  it('placement while an owner exit-side order rests stays blocked (double-exit risk) and WARNs once per tracker', async () => {
    const h = harness({ books: [env([ownerSell])] });
    const warn = jest.spyOn((h.ex as any).logger, 'warn');
    expect((await h.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'NONE', reason: 'OWNER_ORDER_RESTING' });
    await h.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, new Date(NOW.getTime() + 2_000));
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ceiling stop blocked by owner order OWN1'));
    expect(lines).toHaveLength(1);
  });

  it('review fix 3: the owner\'s own full-position STOP (trigger on the loss side) protects — ours is CANCELLED, none placed, WARN once', async () => {
    const ownerSl = { ...ownerSell, orderid: 'OWNSL', variety: 'STOPLOSS', ordertype: 'STOPLOSS_MARKET', triggerprice: '150', price: '0', status: 'trigger pending' };
    const h = harness({ books: [env([ownerSl, ceilingStop()])] });
    const warn = jest.spyOn((h.ex as any).logger, 'warn');
    expect((await h.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OWNER_STOP_PROTECTS' });
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('STOPLOSS', 'SL1');
    expect(h.session.cancelOrderClassified).not.toHaveBeenCalledWith(expect.anything(), 'OWNSL');
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("owner's own stop"))).toBe(true);
    const n = harness({ books: [env([ownerSl])] });
    const nwarn = jest.spyOn((n.ex as any).logger, 'warn');
    expect((await n.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'NONE', reason: 'OWNER_STOP_PROTECTS' });
    await n.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, new Date(NOW.getTime() + 2_000));
    expect(n.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(nwarn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('OWNSL') && l.includes("owner's own stop"))).toHaveLength(1);
  });

  it('review fix 3: an owner target (profit-side LIMIT) keeps ours; a partial owner stop or a loss-side LIMIT falls to today\'s rule', async () => {
    const keep = harness({ books: [env([ownerSell, ceilingStop()])] }); // LIMIT 220 above LTP 186 = target
    expect((await keep.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'KEEP', reason: 'OWNER_ORDER_RESTING' });
    const partial = { ...ownerSell, orderid: 'OWNSL', variety: 'STOPLOSS', ordertype: 'STOPLOSS_MARKET', triggerprice: '150', quantity: '65', status: 'trigger pending' };
    const p = harness({ books: [env([partial, ceilingStop()])] });
    expect((await p.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
    const lossLimit = harness({ books: [env([{ ...ownerSell, price: '170' }, ceilingStop()])] });
    expect((await lossLimit.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
  });

  it('an entry-side owner order: today\'s rule (OTHER_OPEN_ORDER cancels ours)', async () => {
    const h = harness({ books: [env([{ ...ownerSell, transactiontype: 'BUY' }, ceilingStop()])] });
    expect((await h.ex.syncFloorStops('owner', [ceilingIntent()], CEIL, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
  });

  it('EXIT_CANCEL_OWNER_ORDERS=off, or noise mode: today\'s rule (OTHER_OPEN_ORDER cancels ours)', async () => {
    const off = { ...CEIL, exit: parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true', EXIT_CANCEL_OWNER_ORDERS: 'off' }) };
    const h = harness({ books: [env([ownerSell, ceilingStop()])] });
    expect((await h.ex.syncFloorStops('owner', [ceilingIntent()], off, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
    const n = harness({ books: [env([ownerSell, ourStop()])] });
    expect((await n.ex.syncFloorStops('owner', [intent()], CFG, NOW))[0]).toMatchObject({ action: 'CANCEL', reason: 'OTHER_OPEN_ORDER' });
  });

  it('the code exit covers it: an exit cancels the owner order AND our ceiling stop, confirms, then sells once', async () => {
    const V: PendingVerdict = { id: 'cmverdict0000000000000009', userId: 'owner', trackerId: 't1', symbol: 'NIFTY09NOV2624650CE', reason: 'HARD_LOSS', createdAt: new Date(NOW.getTime() - 3_000) };
    const alert = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true);
    const gone = env([{ ...ownerSell, status: 'cancelled' }, { ...ceilingStop(), status: 'cancelled' }]);
    const h = harness({ positions: [env([pos('130', '150')]), env([pos('130', '150')]), env([pos('0', '150')])], books: [env([ownerSell, ceilingStop()]), gone, gone, gone] });
    await h.ex.process(V, EXIT, NOW);
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('NORMAL', 'OWN1');
    expect(h.session.cancelOrderClassified).toHaveBeenCalledWith('STOPLOSS', 'SL1');
    expect(h.calls.filter((c) => c.startsWith('place:MARKET'))).toHaveLength(1);
    expect(h.calls.findIndex((c) => c.startsWith('place:MARKET'))).toBeGreaterThan(h.calls.lastIndexOf('cancel:STOPLOSS:SL1'));
    // Only the owner's order is recorded as an owner cancel (our own stop is not).
    expect(alert).toHaveBeenCalledWith('owner-order-cancelled:t1', expect.not.stringContaining('SL1'));
    alert.mockRestore();
  });
});

describe('exits and the floor stop never overlap', () => {
  const V: PendingVerdict = { id: 'cmverdict0000000000000001', userId: 'owner', trackerId: 't1', symbol: 'NIFTY09NOV2624650CE', reason: 'FLOOR_HARD_EXIT', createdAt: new Date(NOW.getTime() - 3_000) };

  it('while an exit runs on the position, syncFloorStops does not touch its stop', async () => {
    const h = harness({ books: [env([ourStop()])] });
    let inner: unknown;
    const realPos = h.session.getPositionsEnvelope.getMockImplementation()!;
    h.session.getPositionsEnvelope.mockImplementation(async () => {
      if (inner === undefined) inner = await h.ex.syncFloorStops('owner', [intent()], CFG, NOW);
      return realPos();
    });
    await h.ex.process(V, EXIT, NOW);
    expect((inner as Array<{ action: string; reason: string }>)[0]).toMatchObject({ action: 'KEEP', reason: 'EXIT_IN_FLIGHT' });
    expect(h.session.modifyOrderClassified).not.toHaveBeenCalled();
  });

  it('the executor\'s market exit cancels our resting stop FIRST (it is protective), then sells — no double sell', async () => {
    const h = harness({
      positions: [env([pos('130', '175')])],
      books: [env([ourStop()]), env([ourStop()]), env([ourStop({ status: 'cancelled' })]), env([ourStop({ status: 'cancelled' })])],
    });
    await h.ex.process(V, EXIT, NOW);
    const cancel = h.calls.indexOf('cancel:STOPLOSS:SL1');
    const market = h.calls.findIndex((c) => c.startsWith('place:MARKET'));
    expect(cancel).toBeGreaterThan(-1);
    expect(market).toBeGreaterThan(cancel);
  });

  it('if our stop FILLED while the exit was cancelling it, the exit sells nothing (PROTECTIVE_FILLED)', async () => {
    const h = harness({
      positions: [env([pos('130', '175')]), env([pos('0', '180')])],
      books: [env([ourStop()]), env([ourStop({ status: 'complete', filledshares: '130' })])],
    });
    await expect(h.ex.process(V, EXIT, NOW)).resolves.toMatchObject({ status: 'SKIPPED', reason: 'PROTECTIVE_FILLED' });
    expect(h.calls.some((c) => c.startsWith('place:MARKET'))).toBe(false);
  });

  it('an exit that starts while a stop change is in flight waits for it, so its book read sees the stop', async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => { release = r; });
    const h = harness({ place: () => pending as Promise<unknown>, positions: [env([pos('130', '186')])], books: [env([])] });
    const sync = h.ex.syncFloorStops('owner', [intent()], CFG, NOW);
    await new Promise((r) => setImmediate(r));
    let n = 0;
    h.sleep.mockImplementation(async () => { if (++n === 3) release({ status: 'PLACED', orderId: 'SL9', message: 'SUCCESS' }); await new Promise((r) => setImmediate(r)); });
    const exit = h.ex.process(V, EXIT, NOW);
    await Promise.all([sync, exit]);
    const placed = h.calls.indexOf(`place:STOPLOSS:${floorStopTag('t1')}`);
    const exitReads = h.calls.map((c, i) => (c === 'positions' ? i : -1)).filter((i) => i >= 0);
    // positions[0] = the stop's read; the exit's first read comes after the stop was sent and confirmed.
    expect(exitReads[1]).toBeGreaterThan(placed);
  });
});
