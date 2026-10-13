/**
 * AutoExecutionService — broker-outcome settlement (safety batch 2, item 1).
 *
 * smartapi-javascript@1.0.27 never rejects: a network error / its own 7 s axios
 * timeout resolves to `{}`, an HTTP error to `{ status, message }`. The legacy
 * `placeOrder` mapping turned those into REJECTED, so a real order Angel had in
 * fact accepted was settled FAILED + audited ORDER_REJECTED{BROKER_REJECT} — a
 * live position with no ORDER_PLACED audit. These specs pin the classified
 * placement + order-book reconciliation by our own ordertag.
 */
import { AutoExecutionService, autoExecOrderTag } from './auto-execution.service';
import { AutoTradeRiskSizingService } from './auto-trade-risk-sizing.service';
import type { ClassifiedPlacement } from './per-user-broker-session.factory';
import type { PublicSignal, ExecuteUserJob } from '../../signal-fanout';

const CREDS = { apiKey: 'A', apiSecret: 'S', clientId: 'C1', password: 'P', totpSecret: 'JBSWY3DPEHPK3PXP' };
const KEY = 'f3a9c1d2e4b5a6978877665544332211aabbccddeeff00112233445566778899';
const TAG = autoExecOrderTag(KEY);

function harness(placement: ClassifiedPlacement | (() => Promise<ClassifiedPlacement>), book?: unknown | (() => Promise<unknown>)) {
  const rows = new Map<string, { status: string; brokerOrderId?: string; error?: string }>();
  const claims = {
    rows,
    claim: jest.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      if (rows.has(idempotencyKey)) return { acquired: false };
      rows.set(idempotencyKey, { status: 'CLAIMED' });
      return { acquired: true };
    }),
    markPlaced: jest.fn(async (k: string, id: string) => { rows.set(k, { status: 'PLACED', brokerOrderId: id }); }),
    markFailed: jest.fn(async (k: string, e: string) => { rows.set(k, { status: 'FAILED', error: e }); }),
    markUncertain: jest.fn(async (k: string, e: string) => { rows.set(k, { status: 'ORDER_UNCERTAIN', error: e }); }),
  };
  const session = {
    placeOrder: jest.fn(async () => ({ orderId: '', status: 'REJECTED', message: 'legacy mapping must not be used' })),
    placeOrderClassified: jest.fn(async (_order: unknown, _tag?: string) => (typeof placement === 'function' ? placement() : placement)),
    getOrderBookEnvelope: jest.fn(typeof book === 'function' ? (book as () => Promise<unknown>) : async () => book),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const sleep = jest.fn(async () => undefined);
  const service = new AutoExecutionService(
    { hasActive: jest.fn().mockResolvedValue(true) } as never,
    { hasAcceptedCurrent: jest.fn().mockResolvedValue(true) } as never,
    { autoTradeConsent: { findUnique: jest.fn().mockResolvedValue({ enabled: true, killSwitch: false, riskPerTrade: 5000, maxCapital: 100000 }) } } as never,
    { runWithoutTenant: (fn: () => unknown) => fn() } as never,
    { isActive: () => false } as never,
    new AutoTradeRiskSizingService(),
    { validateTrade: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    claims as never,
    { withDecryptedCredentials: jest.fn(async (_u: string, _c: unknown, fn: (c: unknown) => Promise<unknown>) => fn(CREDS)) } as never,
    { withSession: jest.fn(async (_c: unknown, fn: (s: unknown) => Promise<unknown>) => fn(session)) } as never,
    audit as never,
    sleep,
  );
  const audits = (action: string) =>
    audit.append.mock.calls.map((c) => c[0]).filter((e: { action: string }) => e.action === action);
  return { service, claims, session, audit, audits, sleep };
}

const signal: PublicSignal = {
  entryId: 'entry-1', symbol: 'RELIANCE', segment: 'INTRADAY', side: 'BUY',
  entryPrice: 100, targetPct: 5, stopPct: 2, token: '2885',
};
const job: ExecuteUserJob = { userId: 'user-1', signal, idempotencyKey: KEY };

beforeEach(() => { process.env.LIVE_TRADING_ENABLED = 'true'; });
afterEach(() => { delete process.env.LIVE_TRADING_ENABLED; });

describe('autoExecOrderTag', () => {
  it('fits Angel\'s 20-char alphanumeric ordertag limit, is stable, and never collides with the ai-exit prefix', () => {
    expect(TAG).toMatch(/^[A-Za-z0-9]{1,20}$/);
    expect(autoExecOrderTag(KEY)).toBe(TAG);
    expect(TAG.startsWith('ax')).toBe(false);
    expect(autoExecOrderTag('other-key-0000000000000000000000')).not.toBe(TAG);
  });
});

describe('AutoExecutionService — classified placement', () => {
  it('uses placeOrderClassified with the short ordertag, never the legacy placeOrder mapping', async () => {
    const h = harness({ status: 'PLACED', orderId: 'O-1', message: 'ok' });
    await h.service.execute(job);
    expect(h.session.placeOrder).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified.mock.calls[0][1]).toBe(TAG);
    expect(h.claims.markPlaced).toHaveBeenCalledWith(KEY, 'O-1');
    expect(h.audits('ORDER_PLACED')).toHaveLength(1);
    expect(h.session.getOrderBookEnvelope).not.toHaveBeenCalled();
  });

  it('definitive Angel REJECTED → markFailed + ORDER_REJECTED{BROKER_REJECT}, no throw', async () => {
    const h = harness({ status: 'REJECTED', orderId: '', message: 'RMS margin block', errorcode: 'AB4008' });
    await expect(h.service.execute(job)).resolves.toBeUndefined();
    expect(h.claims.markFailed).toHaveBeenCalledWith(KEY, 'RMS margin block');
    expect(h.audits('ORDER_REJECTED').map((a: any) => a.meta.reason)).toEqual(['BROKER_REJECT']);
    expect(h.audits('ORDER_PLACED')).toHaveLength(0);
  });
});

describe('AutoExecutionService — UNCERTAIN placement is reconciled from the order book by ordertag', () => {
  const uncertain: ClassifiedPlacement = { status: 'UNCERTAIN', orderId: '', message: 'no definitive broker answer: {}' };

  it('order found live under our tag → treated as PLACED: markPlaced + ORDER_PLACED (reconciled), never ORDER_REJECTED', async () => {
    const h = harness(uncertain, {
      status: true,
      data: [
        { orderid: 'X-9', ordertag: 'someone-else', status: 'complete' },
        { orderid: 'O-77', ordertag: TAG, status: 'open' },
      ],
    });
    await expect(h.service.execute(job)).resolves.toBeUndefined();
    expect(h.sleep).toHaveBeenCalled();
    expect(h.claims.markPlaced).toHaveBeenCalledWith(KEY, 'O-77');
    const placed = h.audits('ORDER_PLACED');
    expect(placed).toHaveLength(1);
    expect(placed[0].target).toBe('O-77');
    expect(placed[0].meta.reconciled).toBe(true);
    expect(h.audits('ORDER_REJECTED')).toHaveLength(0);
    expect(h.claims.markFailed).not.toHaveBeenCalled();
  });

  it('order found but rejected in the book → BROKER_REJECT with the book text', async () => {
    const h = harness(uncertain, { status: true, data: [{ orderid: 'O-5', ordertag: TAG, status: 'rejected', text: 'RMS: insufficient funds' }] });
    await h.service.execute(job);
    expect(h.claims.markFailed).toHaveBeenCalledWith(KEY, 'RMS: insufficient funds');
    expect(h.audits('ORDER_REJECTED').map((a: any) => a.meta.reason)).toEqual(['BROKER_REJECT']);
    expect(h.audits('ORDER_PLACED')).toHaveLength(0);
  });

  it('book answered without our tag → terminal ORDER_UNCERTAIN (claim + audit), no throw, no retry', async () => {
    const h = harness(uncertain, { status: true, data: [] });
    await expect(h.service.execute(job)).resolves.toBeUndefined();
    expect(h.claims.markUncertain).toHaveBeenCalledTimes(1);
    expect(h.claims.rows.get(KEY)?.status).toBe('ORDER_UNCERTAIN');
    expect(h.claims.markFailed).not.toHaveBeenCalled();
    const u = h.audits('ORDER_UNCERTAIN');
    expect(u).toHaveLength(1);
    expect(u[0].meta.orderTag).toBe(TAG);
    expect(h.audits('ORDER_REJECTED')).toHaveLength(0);
    expect(h.audits('ORDER_PLACED')).toHaveLength(0);
  });

  it('book not answered ({} from the SDK) → ORDER_UNCERTAIN', async () => {
    const h = harness(uncertain, {});
    await h.service.execute(job);
    expect(h.audits('ORDER_UNCERTAIN')).toHaveLength(1);
    expect(h.claims.rows.get(KEY)?.status).toBe('ORDER_UNCERTAIN');
  });

  it('book read throws (timeout) → ORDER_UNCERTAIN', async () => {
    const h = harness(uncertain, async () => { throw new Error('Angel One getOrderBook timed out'); });
    await expect(h.service.execute(job)).resolves.toBeUndefined();
    expect(h.audits('ORDER_UNCERTAIN')).toHaveLength(1);
  });

  it('a Bull retry of an UNCERTAIN job never places a second order', async () => {
    const h = harness(uncertain, { status: true, data: [] });
    await h.service.execute(job);
    await h.service.execute(job);
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.audits('ORDER_UNCERTAIN')).toHaveLength(1);
  });

  it('a fault after the order was sent is ORDER_UNCERTAIN (not a retryable EXECUTION_ERROR)', async () => {
    const h = harness(async () => { throw new Error('socket hang up'); });
    await expect(h.service.execute(job)).resolves.toBeUndefined();
    expect(h.audits('ORDER_UNCERTAIN')).toHaveLength(1);
    expect(h.audits('ORDER_REJECTED')).toHaveLength(0);
    expect(h.claims.rows.get(KEY)?.status).toBe('ORDER_UNCERTAIN');
  });
});
