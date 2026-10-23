jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }));

import { setCoreKillSwitchReader } from '../../trade-core/risk-wall/kill-gate';
import { parseStoredTrigger } from '../../sentinel-executor/domain/stored-trigger';
import type { EntryPlan } from '../domain/gate';
import { SignalExecutorService, type PlaceInput } from './signal-executor.service';

const plan: EntryPlan = {
  exchange: 'NFO', token: '111', tradingsymbol: 'NIFTY28OCT2625000CE', lotSize: 75, tickSize: 0.05, side: 'BUY', ltp: 101,
  bandLow: 100, bandHigh: 103, limitPrice: 101.5, sl: 90, slSource: 'signal', targets: [120, 140], lots: 2, qty: 150, riskRupees: 1725,
};
const input: PlaceInput = { decisionId: 'dec_1', ownerUserId: 'owner', plan, product: 'INTRADAY', qtyUnit: 'units', channel: 'Chan', signalSummary: 'BUY NIFTY 25000 CE', fillWaitSec: 10 };

function make(opts: { placement?: any; book?: unknown[][] } = {}) {
  const orders = new Map<string, Record<string, any>>();
  const repo = {
    claimOrder: jest.fn(async (o: Record<string, any>) => {
      if ([...orders.values()].some((x) => x.decisionId === o.decisionId)) return null;
      const id = `o${orders.size + 1}`;
      orders.set(id, { ...o, status: 'CLAIMED' });
      return id;
    }),
    updateOrder: jest.fn(async (id: string, d: Record<string, any>) => Object.assign(orders.get(id)!, d)),
    findOpenTracker: jest.fn(async () => null as any),
    writeThesis: jest.fn(async () => undefined),
    recordSlVerdict: jest.fn(async () => 'v_sl'),
  };
  const books = [...(opts.book ?? [])];
  const session = {
    placeOrderClassified: jest.fn(async () => opts.placement ?? { status: 'PLACED', orderId: 'B1', message: 'ok' }),
    getOrderBookEnvelope: jest.fn(async () => ({ status: true, data: books.length > 1 ? books.shift() : books[0] ?? [] })),
    cancelOrderClassified: jest.fn(async () => ({ status: 'ACCEPTED', message: 'ok' })),
  };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: (s: any) => any) => fn(session)) };
  const trackers = { backfill: jest.fn(async () => ({ opened: 1, closed: 0, skipped: false })) };
  const svc = new SignalExecutorService(repo as never, sessions as never, trackers as never, async () => undefined);
  return { svc, repo, session, sessions, trackers, orders };
}

describe('SignalExecutorService', () => {
  let killOn = false;
  const OLD = process.env.LIVE_TRADING_ENABLED;
  beforeEach(() => {
    killOn = false;
    process.env.LIVE_TRADING_ENABLED = 'true';
    setCoreKillSwitchReader({ isOn: async () => killOn, isOnForPlatform: async () => killOn, invalidate: () => undefined });
  });
  afterAll(() => {
    process.env.LIVE_TRADING_ENABLED = OLD;
    setCoreKillSwitchReader(null);
  });

  it('claims before sending and sends ONE LIMIT order with the decision ordertag', async () => {
    const t = make({ book: [[{ orderid: 'B1', ordertag: 'sgdec1', status: 'complete', averageprice: '101.4', filledshares: '150' }]] });
    t.svc.followUp = jest.fn(async () => undefined);
    const r = await t.svc.place(input);
    expect(r).toMatchObject({ kind: 'PLACED', brokerOrderId: 'B1' });
    expect(t.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    const [order, tag] = t.session.placeOrderClassified.mock.calls[0] as any[];
    expect(order).toMatchObject({ orderType: 'LIMIT', price: 101.5, quantity: 150, side: 'BUY' });
    expect(order.orderType).not.toBe('MARKET');
    expect(tag).toBe('sgdec1');
    expect(t.repo.claimOrder.mock.invocationCallOrder[0]).toBeLessThan(t.session.placeOrderClassified.mock.invocationCallOrder[0]);
  });

  it('the same decision never sends twice', async () => {
    const t = make();
    t.svc.followUp = jest.fn(async () => undefined);
    await t.svc.place(input);
    const again = await t.svc.place(input);
    expect(again).toEqual({ kind: 'DUPLICATE' });
    expect(t.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('kill switch engaged at the last moment → nothing sent', async () => {
    killOn = true;
    const t = make();
    const r = await t.svc.place(input);
    expect(r).toMatchObject({ kind: 'BLOCKED' });
    expect(t.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('a non-definitive answer is resolved from the order book by OUR tag, never re-sent', async () => {
    const t = make({ placement: { status: 'UNCERTAIN', orderId: '', message: 'no definitive broker answer: {}' }, book: [[{ orderid: 'B9', ordertag: 'sgdec1', status: 'open' }]] });
    t.svc.followUp = jest.fn(async () => undefined);
    expect(await t.svc.place(input)).toMatchObject({ kind: 'PLACED', brokerOrderId: 'B9' });
    const t2 = make({ placement: { status: 'UNCERTAIN', orderId: '', message: '{}' }, book: [[]] });
    expect(await t2.svc.place(input)).toMatchObject({ kind: 'UNCERTAIN' });
    expect(t2.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect([...t2.orders.values()][0].status).toBe('UNCERTAIN');
  });

  it('fill → tracker via reconcile, USER thesis with the signal SL/targets, SL exit trigger proposed', async () => {
    const t = make({ book: [[{ orderid: 'B1', ordertag: 'sgdec1', status: 'complete', averageprice: '101.4', filledshares: '150' }]] });
    t.repo.findOpenTracker.mockResolvedValueOnce(null).mockResolvedValue({ id: 'tr1', symbol: 'NIFTY28OCT2625000CE' });
    const real = t.svc.followUp.bind(t.svc);
    let running: Promise<void> | undefined;
    t.svc.followUp = jest.fn((...a: Parameters<typeof real>) => (running = real(...a)));
    await t.svc.place(input);
    await running;
    expect(t.trackers.backfill).toHaveBeenCalledWith('owner', { positionsOnly: true });
    expect(t.repo.writeThesis).toHaveBeenCalledWith(expect.objectContaining({ trackerId: 'tr1', direction: 'LONG', invalidation: 90, targetPrice: 120, levelPrice: 101.4 }));
    const v = (t.repo.recordSlVerdict.mock.calls[0] as any[])[0];
    expect(parseStoredTrigger(v.exitTrigger)).toEqual({ kind: 'trigger', trigger: { instrument: 'PREMIUM', op: 'BELOW', price: 90, watch: null } });
    expect(t.orders.get('o1')).toMatchObject({ status: 'FILLED', fillPrice: 101.4, trackerId: 'tr1', slVerdictId: 'v_sl' });
  });

  it('an unfilled LIMIT is cancelled after the wait (a resting entry would block exits)', async () => {
    const t = make({ book: [[{ orderid: 'B1', ordertag: 'sgdec1', status: 'open' }]] });
    t.svc.followUp = jest.fn(async () => undefined);
    await t.svc.place({ ...input, fillWaitSec: 0 });
    const real = SignalExecutorService.prototype.followUp.bind(t.svc);
    const books = [[{ orderid: 'B1', status: 'open' }], [{ orderid: 'B1', status: 'cancelled', filledshares: '0' }]];
    t.session.getOrderBookEnvelope.mockImplementation(async () => ({ status: true, data: books.length > 1 ? books.shift() : books[0] }));
    await real('o1', 'B1', 'sgdec1', { ...input, fillWaitSec: 0 });
    expect(t.session.cancelOrderClassified).toHaveBeenCalledWith('NORMAL', 'B1');
    expect(t.orders.get('o1')?.status).toBe('CANCELLED');
    expect(t.repo.recordSlVerdict).not.toHaveBeenCalled();
  });
});
