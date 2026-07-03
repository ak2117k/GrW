/**
 * TDA-011 Phase-2 — AutoExecutionService pipeline (integration, fakes only).
 *
 * Exercises the full ordered pipeline end-to-end (spec §4) with fakes for
 * subscription / consent / AutoTradeConsent / risk-backstop / claim / decrypt /
 * broker / audit. No DB, no Redis, no Nest boot. Proves:
 *   - happy path → claims once, decrypts NESTED, places exactly one order,
 *     markPlaced + a single ORDER_PLACED audit;
 *   - duplicate idempotencyKey (a TDA-010 retry) → second call skips, no 2nd order;
 *   - each gate off (not-subscribed / consent-not-current / autotrade-off /
 *     user kill switch / global LIVE_TRADING_ENABLED off / sizing reject /
 *     risk-backstop veto) → ORDER_REJECTED with the right reason and NO
 *     decrypt/claim/order (the credential decryptor is never touched);
 *   - broker REJECTED → terminal, swallowed + audited (no throw);
 *   - broker FAILED → retryable, throws (Bull retries → DLQ) + audited.
 *
 * Run from apps/api:
 *   npx jest --config test/tda011int/jest.config.js --runInBand --verbose
 */
import { AutoExecutionService } from '../../src/modules/auto-execution/services/auto-execution.service';
import type { PublicSignal, ExecuteUserJob } from '../../src/modules/signal-fanout';
import { AutoTradeRiskSizingService } from '../../src/modules/auto-execution/services/auto-trade-risk-sizing.service';
import type {
  OrderRequest,
  OrderResponse,
} from '../../src/common/interfaces/broker-adapter.interface';

// ---- Fakes ---------------------------------------------------------------

const DUMMY_CREDS = {
  apiKey: 'API', apiSecret: 'SECRET', clientId: 'C1',
  password: 'PW', totpSecret: 'JBSWY3DPEHPK3PXP',
};

function makeFakeClaims() {
  const rows = new Map<string, { status: string; brokerOrderId?: string; error?: string }>();
  return {
    rows,
    claim: jest.fn(async (input: { idempotencyKey: string }) => {
      if (rows.has(input.idempotencyKey)) return { acquired: false };
      rows.set(input.idempotencyKey, { status: 'CLAIMED' });
      return { acquired: true };
    }),
    markPlaced: jest.fn(async (key: string, brokerOrderId: string) => {
      const r = rows.get(key);
      if (r) { r.status = 'PLACED'; r.brokerOrderId = brokerOrderId; }
    }),
    markFailed: jest.fn(async (key: string, error: string) => {
      const r = rows.get(key);
      if (r) { r.status = 'FAILED'; r.error = error; }
    }),
  };
}

/** A fake broker session recording placeOrder; response is configurable. */
function makeFakeSession(response: OrderResponse) {
  return {
    placeOrder: jest.fn(async (_order: OrderRequest, _tag?: string) => response),
  };
}

interface Harness {
  service: AutoExecutionService;
  subscriptions: { hasActive: jest.Mock };
  consent: { hasAcceptedCurrent: jest.Mock };
  prisma: { autoTradeConsent: { findUnique: jest.Mock } };
  risk: { validateTrade: jest.Mock };
  claims: ReturnType<typeof makeFakeClaims>;
  decryptor: { withDecryptedCredentials: jest.Mock };
  brokerFactory: { withSession: jest.Mock };
  session: ReturnType<typeof makeFakeSession>;
  audit: { append: jest.Mock };
}

function makeHarness(opts: {
  consentRow?: { enabled: boolean; killSwitch: boolean; riskPerTrade: number | null; maxCapital: number | null } | null;
  brokerResponse?: OrderResponse;
} = {}): Harness {
  const consentRow =
    opts.consentRow === undefined
      ? { enabled: true, killSwitch: false, riskPerTrade: 5000, maxCapital: 100000 }
      : opts.consentRow;
  const brokerResponse: OrderResponse =
    opts.brokerResponse ?? { orderId: 'BRK-ORD-1', status: 'PLACED', message: 'ok' };

  const subscriptions = { hasActive: jest.fn().mockResolvedValue(true) };
  const consent = { hasAcceptedCurrent: jest.fn().mockResolvedValue(true) };
  const prisma = { autoTradeConsent: { findUnique: jest.fn().mockResolvedValue(consentRow) } };
  const tenant = { runWithoutTenant: <T>(fn: () => T) => fn() };
  const cls = { isActive: () => false };
  const sizing = new AutoTradeRiskSizingService();
  const risk = { validateTrade: jest.fn().mockResolvedValue({ allowed: true }) };
  const claims = makeFakeClaims();
  const session = makeFakeSession(brokerResponse);
  const brokerFactory = {
    withSession: jest.fn(async (_creds: unknown, fn: (s: unknown) => Promise<unknown>) => fn(session)),
  };
  const decryptor = {
    withDecryptedCredentials: jest.fn(
      async (_userId: string, _ctx: unknown, fn: (c: unknown) => Promise<unknown>) => fn(DUMMY_CREDS),
    ),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };

  const service = new AutoExecutionService(
    subscriptions as never,
    consent as never,
    prisma as never,
    tenant as never,
    cls as never,
    sizing,
    risk as never,
    claims as never,
    decryptor as never,
    brokerFactory as never,
    audit as never,
  );

  return { service, subscriptions, consent, prisma, risk, claims, decryptor, brokerFactory, session, audit };
}

const signal: PublicSignal = {
  entryId: 'entry-1',
  symbol: 'RELIANCE',
  segment: 'INTRADAY',
  side: 'BUY',
  entryPrice: 100,
  targetPct: 5,
  stopPct: 2,
  token: '2885',
};
const job: ExecuteUserJob = { userId: 'user-1', signal, idempotencyKey: 'idem-1' };

/** Audit rows appended with a given action. */
const auditsFor = (h: Harness, action: string) =>
  h.audit.append.mock.calls.map((c) => c[0]).filter((e: { action: string }) => e.action === action);

beforeEach(() => {
  process.env.LIVE_TRADING_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.LIVE_TRADING_ENABLED;
});

describe('AutoExecutionService.execute — happy path', () => {
  it('claims once, decrypts NESTED, places exactly one order, markPlaced + one ORDER_PLACED audit', async () => {
    const h = makeHarness();

    await h.service.execute(job);

    // claim before any decrypt/order
    expect(h.claims.claim).toHaveBeenCalledTimes(1);
    // decrypt happened with the ORDER reason + signalId, exactly once
    expect(h.decryptor.withDecryptedCredentials).toHaveBeenCalledTimes(1);
    const [uid, ctx] = h.decryptor.withDecryptedCredentials.mock.calls[0];
    expect(uid).toBe('user-1');
    expect(ctx).toEqual({ reason: 'ORDER', signalId: 'entry-1' });
    // the broker session was built INSIDE the decrypt lease with the yielded creds
    expect(h.brokerFactory.withSession).toHaveBeenCalledTimes(1);
    expect(h.brokerFactory.withSession.mock.calls[0][0]).toBe(DUMMY_CREDS);
    // exactly one order, tagged with the idempotency key
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
    const [order, tag] = h.session.placeOrder.mock.calls[0];
    expect(tag).toBe('idem-1');
    expect(order.symbol).toBe('RELIANCE');
    expect(order.side).toBe('BUY');
    expect(order.quantity).toBeGreaterThan(0);
    // settled + audited
    expect(h.claims.markPlaced).toHaveBeenCalledWith('idem-1', 'BRK-ORD-1');
    expect(auditsFor(h, 'ORDER_PLACED')).toHaveLength(1);
    expect(auditsFor(h, 'ORDER_REJECTED')).toHaveLength(0);
    // no secret in the audit meta
    expect(JSON.stringify(h.audit.append.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(h.audit.append.mock.calls)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

describe('AutoExecutionService.execute — idempotency (TDA-010 retry)', () => {
  it('a duplicate idempotencyKey places NO second order and does not throw', async () => {
    const h = makeHarness();

    await h.service.execute(job);
    await h.service.execute(job); // retry, same key

    expect(h.claims.claim).toHaveBeenCalledTimes(2);
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1); // only the first placed
    expect(h.decryptor.withDecryptedCredentials).toHaveBeenCalledTimes(1);
    expect(auditsFor(h, 'ORDER_PLACED')).toHaveLength(1);
  });
});

describe('AutoExecutionService.execute — gates (terminal, no decrypt/claim/order)', () => {
  const expectRejectedNoSideEffects = (h: Harness, reason: string) => {
    expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(h.claims.claim).not.toHaveBeenCalled();
    expect(h.session.placeOrder).not.toHaveBeenCalled();
    const rejects = auditsFor(h, 'ORDER_REJECTED');
    expect(rejects).toHaveLength(1);
    expect(rejects[0].meta.reason).toContain(reason);
  };

  it('not subscribed → NOT_SUBSCRIBED', async () => {
    const h = makeHarness();
    h.subscriptions.hasActive.mockResolvedValue(false);
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'NOT_SUBSCRIBED');
  });

  it('consent not current → CONSENT_NOT_CURRENT', async () => {
    const h = makeHarness();
    h.consent.hasAcceptedCurrent.mockResolvedValue(false);
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'CONSENT_NOT_CURRENT');
  });

  it('autotrade disabled (enabled=false) → AUTOTRADE_OFF', async () => {
    const h = makeHarness({ consentRow: { enabled: false, killSwitch: false, riskPerTrade: 5000, maxCapital: 100000 } });
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'AUTOTRADE_OFF');
  });

  it('missing AutoTradeConsent row → AUTOTRADE_OFF', async () => {
    const h = makeHarness({ consentRow: null });
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'AUTOTRADE_OFF');
  });

  it('per-user kill switch on → USER_KILL_SWITCH', async () => {
    const h = makeHarness({ consentRow: { enabled: true, killSwitch: true, riskPerTrade: 5000, maxCapital: 100000 } });
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'USER_KILL_SWITCH');
  });

  it('global LIVE_TRADING_ENABLED off → LIVE_TRADING_DISABLED, no decrypt/order', async () => {
    const h = makeHarness();
    delete process.env.LIVE_TRADING_ENABLED;
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'LIVE_TRADING_DISABLED');
  });

  it('sizing rejects (maxCapital below 1 lot) → RISK_SIZE_ZERO', async () => {
    const h = makeHarness({ consentRow: { enabled: true, killSwitch: false, riskPerTrade: 5000, maxCapital: 50 } });
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'RISK_SIZE_ZERO');
  });

  it('risk backstop veto → RISK_BACKSTOP', async () => {
    const h = makeHarness();
    h.risk.validateTrade.mockResolvedValue({ allowed: false, reason: 'Market closed' });
    await h.service.execute(job);
    expectRejectedNoSideEffects(h, 'RISK_BACKSTOP');
  });
});

describe('AutoExecutionService.execute — broker outcomes', () => {
  it('broker REJECTED → terminal: markFailed + ORDER_REJECTED{BROKER_REJECT}, no throw', async () => {
    const h = makeHarness({ brokerResponse: { orderId: '', status: 'REJECTED', message: 'RMS margin block' } });

    await expect(h.service.execute(job)).resolves.toBeUndefined();

    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.claims.markFailed).toHaveBeenCalledWith('idem-1', 'RMS margin block');
    const rejects = auditsFor(h, 'ORDER_REJECTED');
    expect(rejects).toHaveLength(1);
    expect(rejects[0].meta.reason).toBe('BROKER_REJECT');
    expect(auditsFor(h, 'ORDER_PLACED')).toHaveLength(0);
  });

  it('broker FAILED → retryable: throws (Bull retries → DLQ) + markFailed + ORDER_REJECTED{BROKER_FAULT}', async () => {
    const h = makeHarness({ brokerResponse: { orderId: '', status: 'FAILED', message: 'timeout' } });

    await expect(h.service.execute(job)).rejects.toThrow(/retryable/i);

    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.claims.markFailed).toHaveBeenCalledWith('idem-1', 'timeout');
    const rejects = auditsFor(h, 'ORDER_REJECTED');
    expect(rejects).toHaveLength(1);
    expect(rejects[0].meta.reason).toBe('BROKER_FAULT');
  });

  it('decrypt/session fault → retryable: throws + markFailed (claim held, no double-place on retry)', async () => {
    const h = makeHarness();
    h.decryptor.withDecryptedCredentials.mockRejectedValue(new Error('KMS unavailable'));

    await expect(h.service.execute(job)).rejects.toThrow('KMS unavailable');

    expect(h.claims.claim).toHaveBeenCalledTimes(1); // claimed before decrypt
    expect(h.claims.markFailed).toHaveBeenCalledTimes(1);
    expect(auditsFor(h, 'ORDER_REJECTED')).toHaveLength(1);
  });
});
