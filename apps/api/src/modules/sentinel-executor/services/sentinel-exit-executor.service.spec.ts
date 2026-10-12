// apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts
import { SentinelExitExecutor } from './sentinel-exit-executor.service';
import { FeedSessionNotReadyError } from './owner-broker-session.provider';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { aiExitOrderTag } from '../domain/exit-order';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';

const NOW = new Date('2026-10-12T10:00:00Z');
const V: PendingVerdict = {
  id: 'cm9verdict000000000000001', userId: 'owner', trackerId: 't1',
  symbol: 'CRUDEOIL15OCT268950CE', reason: 'thesis broken', createdAt: new Date(NOW.getTime() - 5_000),
};
// R16: MCX has no default unit, so the live fixtures configure it explicitly.
const LIVE = parseAutoExitConfig({
  AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:units',
});
const LIVE_NO_MCX_UNIT = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' });
const DRY = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
const DRY_MCX_UNITS = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:units' });

const posRow = (netqty: string, ltp = '50.25', extra: Record<string, unknown> = {}) => ({
  tradingsymbol: 'CRUDEOIL15OCT268950CE', symboltoken: '445566', exchange: 'MCX',
  producttype: 'CARRYFORWARD', netqty, ltp, ...extra,
});
const env = (data: unknown) => ({ status: true, data });

function harness(opts: {
  positions?: unknown[];         // successive getPositionsEnvelope answers (an Error is thrown)
  books?: unknown[];             // successive getOrderBookEnvelope answers (an Error is thrown)
  place?: unknown[];             // successive placeOrderClassified results
  claim?: string | null;
  tracker?: unknown;
  counted?: number;
  inFlight?: boolean;
  open?: boolean;
  tick?: number | null;
  lotSize?: number | null;
} = {}) {
  const calls: string[] = [];
  const queue = <T>(xs: T[] | undefined, dflt: T) => {
    const q = [...(xs ?? [])];
    return () => (q.length > 1 ? q.shift()! : q[0] ?? dflt);
  };
  const answer = (x: unknown) => {
    if (x instanceof Error) throw x;
    return x;
  };
  const nextPos = queue(opts.positions, env([posRow('100')]) as unknown);
  const nextBook = queue(opts.books, env([]) as unknown);
  const nextPlace = queue(opts.place, { orderId: 'O1', status: 'PLACED', message: 'SUCCESS' } as unknown);

  const session = {
    getPositionsEnvelope: jest.fn(async () => { calls.push('positions'); return answer(nextPos()); }),
    getOrderBookEnvelope: jest.fn(async () => { calls.push('book'); return answer(nextBook()); }),
    placeOrderClassified: jest.fn(async (o: any, tag: string) => { calls.push(`place:${o.orderType}:${tag}`); return nextPlace(); }),
  };
  const repo = {
    claim: jest.fn(async () => { calls.push('claim'); return opts.claim === undefined ? 'row1' : opts.claim; }),
    update: jest.fn(async (_id: string, patch: any) => { calls.push(`update:${patch.status ?? (patch.quantity != null ? 'plan' : '-')}`); }),
    countCountedSince: jest.fn(async () => opts.counted ?? 0),
    hasInFlight: jest.fn(async () => opts.inFlight ?? false),
  };
  const prisma = {
    tradeTracker: {
      findUnique: jest.fn(async () => (opts.tracker === undefined
        ? { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX', token: '445566', qty: 100 }
        : opts.tracker)),
    },
    instrument: {
      findFirst: jest.fn(async () => (opts.tick === null
        ? null
        : { tickSize: opts.tick === undefined ? 10 : opts.tick, lotSize: opts.lotSize ?? null })),
    },
  };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any) => fn(session, 'user-feed')) };
  const clock = { isOpen: jest.fn(() => opts.open ?? true) };
  const sleep = jest.fn(async () => undefined);
  const ex = new SentinelExitExecutor(repo as never, prisma as never, sessions as never, clock as never, sleep);
  const lastPatch = () => repo.update.mock.calls.at(-1)?.[1];
  const patches = () => repo.update.mock.calls.map((c) => c[1]);
  return { ex, session, repo, prisma, sessions, calls, lastPatch, patches, sleep };
}

describe('SentinelExitExecutor', () => {
  it('claims BEFORE any broker call, and a lost claim makes no broker call at all', async () => {
    const h = harness();
    await h.ex.process(V, LIVE, NOW);
    expect(h.calls[0]).toBe('claim');
    expect(h.calls.indexOf('claim')).toBeLessThan(h.calls.findIndex((c) => c.startsWith('place')));
    expect(h.calls.indexOf('claim')).toBeLessThan(h.calls.indexOf('positions'));

    const lost = harness({ claim: null });
    await expect(lost.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'DUPLICATE' });
    expect(lost.sessions.withOwnerSession).not.toHaveBeenCalled();
    expect(lost.repo.update).not.toHaveBeenCalled();
    expect(lost.prisma.tradeTracker.findUnique).not.toHaveBeenCalled();
  });

  it('the planned order is written to the row BEFORE placeOrderClassified', async () => {
    const h = harness({ positions: [env([posRow('100')]), env([posRow('0')])] });
    await h.ex.process(V, LIVE, NOW);
    const planned = h.calls.indexOf('update:plan');
    expect(planned).toBeGreaterThan(h.calls.indexOf('claim'));
    expect(planned).toBeLessThan(h.calls.findIndex((c) => c.startsWith('place')));
  });

  it('dry-run reads the book, records the exact order, sends nothing', async () => {
    const h = harness();
    await expect(h.ex.process(V, DRY_MCX_UNITS, NOW)).resolves.toEqual({
      status: 'DRY_RUN', reason: 'would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
    });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(h.session.getOrderBookEnvelope).toHaveBeenCalled();
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionSource: 'user-feed' }),
      expect.objectContaining({ side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', exchange: 'MCX', token: '445566' }),
      expect.objectContaining({ status: 'DRY_RUN' }),
    ]));
  });

  it('dry-run with no configured unit for the exchange records the row flagged UNIT_UNVERIFIED (R16), sends nothing', async () => {
    const h = harness();
    await expect(h.ex.process(V, DRY, NOW)).resolves.toEqual({
      status: 'DRY_RUN', reason: 'UNIT_UNVERIFIED: would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
    });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(h.lastPatch()).toEqual(expect.objectContaining({ status: 'DRY_RUN', reason: expect.stringMatching(/^UNIT_UNVERIFIED: /) }));
  });

  it('live with no configured unit for the exchange → SKIPPED: QTY_UNIT_UNCONFIGURED:MCX, no order (R16)', async () => {
    const h = harness();
    await expect(h.ex.process(V, LIVE_NO_MCX_UNIT, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'QTY_UNIT_UNCONFIGURED:MCX' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('lots unit: the instrument lot size converts |netqty| to lots (R16)', async () => {
    const lots = parseAutoExitConfig({
      AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:lots',
    });
    const h = harness({ lotSize: 10, positions: [env([posRow('100', '50.25', { lotsize: '10' })]), env([posRow('0')])] });
    await h.ex.process(V, lots, NOW);
    expect(h.prisma.instrument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { exchange: 'MCX', token: '445566' }, select: { tickSize: true, lotSize: true },
    }));
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified.mock.calls[0][0]).toEqual(expect.objectContaining({ side: 'SELL', quantity: 10 }));
  });

  it('lots unit with a disagreeing broker lot size → SKIPPED: LOT_SIZE_MISMATCH, no order', async () => {
    const lots = parseAutoExitConfig({
      AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:lots',
    });
    const h = harness({ lotSize: 10, positions: [env([posRow('100', '50.25', { lotsize: '100' })])] });
    await expect(h.ex.process(V, lots, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'LOT_SIZE_MISMATCH' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('live: exactly one MARKET order with the ordertag, then FILLED when the book is flat', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('0')])],
      books: [env([]), env([{ orderid: 'O1', status: 'complete', text: '', symboltoken: '445566', exchange: 'MCX' }])],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FILLED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified.mock.calls[0][1]).toBe(aiExitOrderTag(V.id, 'M'));
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PLACED', brokerOrderId: 'O1' }),
      expect.objectContaining({ status: 'FILLED', orderStatus: 'complete' }),
    ]));
  });

  it('a short is closed with a BUY of |netqty|', async () => {
    const h = harness({
      tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX', token: '445566', qty: -100 },
      positions: [env([posRow('-100')]), env([posRow('0')])],
    });
    await h.ex.process(V, LIVE, NOW);
    expect(h.session.placeOrderClassified.mock.calls[0][0]).toEqual(expect.objectContaining({ side: 'BUY', quantity: 100 }));
  });

  it('tracker long but broker short → SKIPPED: SIDE_MISMATCH, never reverse', async () => {
    const h = harness({ positions: [env([posRow('-100')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'SIDE_MISMATCH' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('two non-flat rows for the contract → SKIPPED: AMBIGUOUS_POSITION_ROWS', async () => {
    const h = harness({ positions: [env([posRow('100'), { ...posRow('50'), producttype: 'INTRADAY' }])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'AMBIGUOUS_POSITION_ROWS' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('sync MARKET refusal → exactly one LIMIT at LTP − 2 % on the tick, tag leg L', async () => {
    const h = harness({
      place: [
        { orderId: '', status: 'REJECTED', message: 'Market orders are not allowed for this instrument' },
        { orderId: 'O2', status: 'PLACED', message: 'SUCCESS' },
      ],
      tick: 10, // paise → ₹0.10
    });
    await h.ex.process(V, LIVE, NOW);
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(2);
    const [, [limit, tag]] = h.session.placeOrderClassified.mock.calls;
    expect(limit).toEqual(expect.objectContaining({ orderType: 'LIMIT', price: 49.2, quantity: 100, side: 'SELL' }));
    expect(tag).toBe(aiExitOrderTag(V.id, 'L'));
  });

  it('async MARKET refusal in the order book → one LIMIT; a refusal of the LIMIT never triggers another', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('100')]), env([posRow('100')])],
      books: [
        env([]),
        env([{ orderid: 'O1', status: 'rejected', text: 'MARKET orders are blocked, place a LIMIT order', symboltoken: '445566', exchange: 'MCX' }]),
        env([{ orderid: 'O1', status: 'rejected', text: '', symboltoken: '445566', exchange: 'MCX' }]),
        env([{ orderid: 'O2', status: 'rejected', text: 'Market orders are not allowed', symboltoken: '445566', exchange: 'MCX' }]),
      ],
      place: [{ orderId: 'O1', status: 'PLACED', message: 'ok' }, { orderId: 'O2', status: 'PLACED', message: 'ok' }],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual(expect.objectContaining({ status: 'REJECTED' }));
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(2);
    expect(h.patches()).toEqual(expect.arrayContaining([expect.objectContaining({ marketOrderId: 'O1', orderType: 'LIMIT' })]));
  });

  it('fallback aborts when the position changed between the two orders (never exceed)', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('50')])],
      place: [{ orderId: '', status: 'REJECTED', message: 'Market orders are not allowed' }],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'FALLBACK_ABORTED:POSITION_CHANGED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('fallback aborts when an order now rests on the contract', async () => {
    const h = harness({
      books: [env([]), env([{ orderid: 'O9', status: 'open', symboltoken: '445566', exchange: 'MCX' }])],
      place: [{ orderId: '', status: 'REJECTED', message: 'Market orders are not allowed' }],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'FALLBACK_ABORTED:OPEN_ORDER_EXISTS' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('any other rejection → REJECTED, no retry', async () => {
    const h = harness({ place: [{ orderId: '', status: 'REJECTED', message: 'Insufficient margin' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'REJECTED', reason: 'BROKER_REJECTED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.lastPatch()).toEqual(expect.objectContaining({ brokerMessage: 'Insufficient margin' }));
  });

  it('placeOrderClassified FAILED (timeout) → ORDER_UNCERTAIN, one call, no fallback', async () => {
    const h = harness({ place: [{ orderId: '', status: 'FAILED', message: 'Angel One placeOrderClassified timed out after 15000ms' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('placeOrderClassified FAILED whose message mentions a MARKET refusal is still ORDER_UNCERTAIN (no fallback)', async () => {
    const h = harness({ place: [{ orderId: '', status: 'FAILED', message: 'market orders not allowed (socket hang up)' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('PLACED without an order id is ORDER_UNCERTAIN, never re-sent', async () => {
    const h = harness({ place: [{ orderId: '', status: 'PLACED', message: 'ok' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('broker read not answered → FAILED: BROKER_READ, no order', async () => {
    const h = harness({ positions: [{ status: false, data: null }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'BROKER_READ' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('broker read that throws (timeout) → FAILED: BROKER_READ, no order', async () => {
    const h = harness({ positions: [new Error('Angel One getPosition timed out after 15000ms')] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'BROKER_READ' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('order book not answered → FAILED: ORDER_BOOK_READ, no order', async () => {
    const h = harness({ books: [{ status: false, data: null }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_BOOK_READ' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('a confirm-step read that throws after the order is PLACED leaves the row PLACED (never FAILED, never re-sent)', async () => {
    const h = harness({
      books: [env([]), new Error('Angel One getOrderBook timed out after 15000ms')],
      positions: [env([posRow('100')]), new Error('Angel One getPosition timed out')],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'PLACED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.patches().some((p) => p.status === 'FAILED')).toBe(false);
  });

  it('confirm polls at +2 s, +5 s, +10 s and stops at a terminal status', async () => {
    const h = harness({ books: [env([]), env([]), env([]), env([])], positions: [env([posRow('100')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'PLACED' });
    expect(h.sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([2_000, 3_000, 5_000]);
  });

  it('an open order on the contract → SKIPPED: OPEN_ORDER_EXISTS (a second verdict while the first order rests)', async () => {
    const h = harness({ books: [env([{ orderid: 'O0', status: 'open', symboltoken: '445566', exchange: 'MCX' }])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'OPEN_ORDER_EXISTS' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('already flat → SKIPPED: ALREADY_FLAT', async () => {
    const h = harness({ positions: [env([posRow('0')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'ALREADY_FLAT' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it.each([
    ['stale verdict', { }, { ...V, createdAt: new Date(NOW.getTime() - 91_000) }, 'STALE_VERDICT'],
    ['closed exchange', { open: false }, V, 'EXCHANGE_CLOSED'],
    ['holding', { tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'HOLDING', exchange: 'NSE', token: '1', qty: 10 } }, V, 'NOT_POSITION'],
    ['cash equity position', { tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NSE', token: '1', qty: 10 } }, V, 'EXCHANGE_NOT_FNO'],
    ['missing tracker', { tracker: null }, V, 'TRACKER_MISSING'],
    ['daily cap', { counted: 5 }, V, 'DAILY_CAP'],
    ['in flight', { inFlight: true }, V, 'EXIT_IN_FLIGHT'],
  ])('%s → SKIPPED with no session at all', async (_n, opts, verdict, reason) => {
    const h = harness(opts as never);
    await expect(h.ex.process(verdict as PendingVerdict, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason });
    expect(h.sessions.withOwnerSession).not.toHaveBeenCalled();
  });

  it('a session error is FAILED with a generic reason (no creds), never thrown', async () => {
    const h = harness();
    h.sessions.withOwnerSession.mockRejectedValueOnce(new Error('Angel One rejected the credentials for order placement'));
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'SESSION' });
    expect(h.lastPatch()).toEqual(expect.objectContaining({ brokerMessage: 'Angel One rejected the credentials for order placement' }));
  });

  it('owner feed mid re-login → SKIPPED: FEED_SESSION_NOT_READY, visible row, no order and no retry', async () => {
    const h = harness();
    h.sessions.withOwnerSession.mockRejectedValueOnce(new FeedSessionNotReadyError());
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'FEED_SESSION_NOT_READY' });
    expect(h.sessions.withOwnerSession).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(h.lastPatch()).toEqual(expect.objectContaining({ status: 'SKIPPED', reason: 'FEED_SESSION_NOT_READY' }));
  });

  it('an error after an order was sent is ORDER_UNCERTAIN, not SESSION', async () => {
    const h = harness();
    h.repo.update.mockImplementation(async (_id: string, patch: any) => {
      if (patch.status === 'PLACED') throw new Error('db blip');
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review fix 1. The real AngelOneUserBrokerSession over a fake SDK client that
 * answers exactly like smartapi-javascript@1.0.27's interceptor: it RESOLVES `{}`
 * on a network error / 7 s timeout and `{status:<http>,message}` on an HTTP
 * error. Neither may become REJECTED, a retry, or a LIMIT fallback.
 */
describe('SentinelExitExecutor — placement outcome through the REAL session (SDK interceptor shapes)', () => {
  const TAG_M = aiExitOrderTag(V.id, 'M');
  const bookRow = (o: Record<string, unknown>) => ({ symboltoken: '445566', exchange: 'MCX', ...o });

  function real(place: unknown[], books: unknown[] = [env([])]) {
    const h = harness();
    const q = <T>(xs: T[]) => { const a = [...xs]; return () => (a.length > 1 ? a.shift()! : a[0]); };
    const nextPlace = q(place);
    const nextBook = q(books);
    const client = {
      generateSession: jest.fn(), logout: jest.fn(), getRMS: jest.fn(), getProfile: jest.fn(),
      getAllHolding: jest.fn(), getTradeBook: jest.fn(),
      getPosition: jest.fn(async () => env([posRow('100')])),
      getOrderBook: jest.fn(async () => nextBook()),
      placeOrder: jest.fn(async (_p: Record<string, string>) => nextPlace()),
    };
    const factory = new PerUserBrokerSessionFactory(() => { throw new Error('no login'); });
    h.sessions.withOwnerSession.mockImplementation(async (_u: string, fn: any) =>
      factory.borrow(client as never, 'C1', (s) => fn(s, 'user-feed')));
    return { ...h, client };
  }

  it.each([
    ['network error / SDK 7 s timeout → {}', {}],
    ['HTTP 504 → {status:504,message:"Gateway Time-out"}', { status: 504, message: 'Gateway Time-out' }],
  ])('%s → FAILED: ORDER_UNCERTAIN, one order, no fallback', async (_n, answer) => {
    const r = real([answer]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
    expect(r.client.placeOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ ordertype: 'MARKET', ordertag: TAG_M }));
    expect(r.patches().some((p) => p.status === 'REJECTED' || p.orderType === 'LIMIT')).toBe(false);
  });

  it('a "market not allowed" text inside an HTTP-error shape never triggers the LIMIT fallback', async () => {
    const r = real([{ status: 502, message: 'Market orders are not allowed' }]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('uncertain answer but our ordertag is in the book → PLACED with the book order id, never re-sent', async () => {
    const r = real([{}], [
      env([]), // pre-order check
      env([bookRow({ orderid: 'O77', ordertag: TAG_M, status: 'open' })]),
    ]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'PLACED' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
    expect(r.patches()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'PLACED', brokerOrderId: 'O77' })]));
  });

  it('uncertain answer and the order book is not answered → FAILED: ORDER_UNCERTAIN', async () => {
    const r = real([{}], [env([]), {}]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('Angel answered status:false (definitive) and no order of our tag → REJECTED: BROKER_REJECTED', async () => {
    const r = real([{ status: false, message: 'Insufficient margin', errorcode: 'AB4036', data: null }]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'REJECTED', reason: 'BROKER_REJECTED' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
    expect(r.lastPatch()).toEqual(expect.objectContaining({ brokerMessage: 'Insufficient margin' }));
  });

  it('a definitive rejection whose book read is not answered → FAILED: ORDER_UNCERTAIN (no fallback)', async () => {
    const r = real([{ status: false, message: 'Market orders are not allowed', errorcode: 'AB4000' }], [env([]), {}]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('a definitive MARKET refusal while our MARKET order is live in the book → no LIMIT fallback', async () => {
    const r = real([{ status: false, message: 'Market orders are not allowed', errorcode: 'AB4000' }], [
      env([]),
      env([bookRow({ orderid: 'O5', ordertag: TAG_M, status: 'open' })]),
    ]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'PLACED' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('a definitive MARKET refusal with no order in the book → exactly one LIMIT', async () => {
    const r = real([
      { status: false, message: 'Market orders are not allowed', errorcode: 'AB4000' },
      { status: true, message: 'SUCCESS', data: { orderid: 'O2' } },
    ]);
    await r.ex.process(V, LIVE, NOW);
    expect(r.client.placeOrder).toHaveBeenCalledTimes(2);
    expect(r.client.placeOrder.mock.calls[1][0]).toEqual(expect.objectContaining({ ordertype: 'LIMIT', ordertag: aiExitOrderTag(V.id, 'L') }));
  });

  it('an uncertain LIMIT leg → FAILED: ORDER_UNCERTAIN, never a third order', async () => {
    const r = real([{ status: false, message: 'Market orders are not allowed', errorcode: 'AB4000' }, {}]);
    await expect(r.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(r.client.placeOrder).toHaveBeenCalledTimes(2);
  });
});
