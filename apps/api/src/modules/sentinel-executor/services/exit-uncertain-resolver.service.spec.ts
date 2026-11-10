// apps/api/src/modules/sentinel-executor/services/exit-uncertain-resolver.service.spec.ts
jest.mock('../../../common/utils/ops-alert', () => ({ sendOpsAlert: jest.fn(async () => true) }));
import { Logger } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { aiExitOrderTag } from '../domain/exit-order';
import { ORDER_NOT_FOUND, UNCERTAIN_PER_SWEEP, UNCERTAIN_RECHECK_GAP_MS, type UncertainExitRow } from '../domain/uncertain-exit';
import { ExitUncertainResolver } from './exit-uncertain-resolver.service';

const alert = sendOpsAlert as jest.Mock;
const SENT = new Date('2026-11-10T13:20:00Z'); // 18:50 IST
const T1 = new Date(SENT.getTime() + 90_000);
const T2 = new Date(T1.getTime() + UNCERTAIN_RECHECK_GAP_MS);
const ROW: UncertainExitRow = {
  id: 'r1', userId: 'owner', verdictId: 'trg_cmtrigger1', trackerId: 't1', symbol: 'CRUDEOILM17NOV267950PE',
  exchange: 'MCX', token: '472790', side: 'SELL', quantity: 30, orderType: 'MARKET', reason: 'ORDER_UNCERTAIN',
  brokerMessage: 'no definitive broker answer: {}', orderSentAt: SENT, createdAt: new Date(SENT.getTime() - 3_000),
  updatedAt: new Date(SENT.getTime() + 2_500),
};
const TAG = aiExitOrderTag(ROW.verdictId, 'M', 'PRICE_TRIGGER');
const POSITIONS = { status: true, data: [{ exchange: 'MCX', symboltoken: '472790', tradingsymbol: 'CRUDEOILM17NOV267950PE', netqty: '30', producttype: 'CARRYFORWARD', ltp: '61.5', lotsize: '10' }] };
const EMPTY_BOOK = { status: true, data: [] };
const CFG = { qtyUnits: { MCX: 'units' as const, NFO: 'units' as const } };

function make(opts: { book?: unknown; positions?: unknown; rows?: UncertainExitRow[] } = {}) {
  const repo = {
    uncertainSince: jest.fn(async () => opts.rows ?? [ROW]),
    resolveUncertain: jest.fn(async () => true),
  };
  const session = {
    getOrderBookEnvelope: jest.fn(async () => opts.book ?? EMPTY_BOOK),
    getPositionsEnvelope: jest.fn(async () => opts.positions ?? POSITIONS),
    placeOrderClassified: jest.fn(), placeOrder: jest.fn(), cancelOrderClassified: jest.fn(), modifyOrderClassified: jest.fn(),
    convertPosition: jest.fn(),
  };
  const sessions = {
    withOwnerSession: jest.fn(async (_u: string, fn: any, o: any) => {
      expect(o).toEqual({ allowEphemeralLogin: false }); // never a broker login
      return fn(session, 'user-feed');
    }),
  };
  const r = new ExitUncertainResolver(repo as never, sessions as never);
  return { r, repo, session, sessions };
}
const noOrderCalls = (session: ReturnType<typeof make>['session']) => {
  expect(session.placeOrderClassified).not.toHaveBeenCalled();
  expect(session.placeOrder).not.toHaveBeenCalled();
  expect(session.cancelOrderClassified).not.toHaveBeenCalled();
  expect(session.modifyOrderClassified).not.toHaveBeenCalled();
  expect(session.convertPosition).not.toHaveBeenCalled();
};

describe('ExitUncertainResolver (2026-11-10: a lost order answer must not block every later exit all day)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    alert.mockClear();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads today\'s unknown-fate rows from the IST day start', async () => {
    const { r, repo } = make();
    await r.runOnce(CFG, T1);
    expect(repo.uncertainSince).toHaveBeenCalledWith(new Date('2026-11-09T18:30:00Z'));
  });

  it('our tag found complete ⇒ FILLED with the fill (only while still FAILED with its reason); no order call', async () => {
    const book = { status: true, data: [{ orderid: 'O1', ordertag: TAG, status: 'complete', averageprice: '60.2', filledshares: '30', exchorderupdatetime: '10-Nov-2026 18:50:03' }] };
    const { r, repo, session } = make({ book });
    await r.runOnce(CFG, T1);
    expect(repo.resolveUncertain).toHaveBeenCalledWith('r1', 'ORDER_UNCERTAIN', expect.objectContaining({
      status: 'FILLED', reason: null, brokerOrderId: 'O1', orderStatus: 'complete', fillPrice: 60.2, fillQty: 30,
      fillAt: new Date('2026-11-10T13:20:03Z'),
    }));
    const patch = (repo.resolveUncertain.mock.calls[0] as unknown[])[2] as { brokerMessage: string };
    expect(patch.brokerMessage).toMatch(/^no definitive broker answer: \{\} \| resolver .*order O1 .* is complete$/);
    expect(alert).toHaveBeenCalledWith('ai-exit-resolve:r1:FILLED', expect.stringContaining('DID go through'));
    noOrderCalls(session);
  });

  it('our tag found open ⇒ PLACED with the broker order id (the block stays, correctly)', async () => {
    const { r, repo } = make({ book: { status: true, data: [{ orderid: 'O2', ordertag: TAG, status: 'open' }] } });
    await r.runOnce(CFG, T1);
    expect(repo.resolveUncertain).toHaveBeenCalledWith('r1', 'ORDER_UNCERTAIN', expect.objectContaining({ status: 'PLACED', brokerOrderId: 'O2', orderStatus: 'open' }));
  });

  it('our tag rejected ⇒ REJECTED (unblocks), loud WARN + alert', async () => {
    const { r, repo, session } = make({ book: { status: true, data: [{ orderid: 'O1', ordertag: TAG, status: 'rejected', text: 'RMS: blocked' }] } });
    await r.runOnce(CFG, T1);
    expect(repo.resolveUncertain).toHaveBeenCalledWith('r1', 'ORDER_UNCERTAIN', expect.objectContaining({
      status: 'REJECTED', reason: 'BROKER_REJECTED', orderStatus: 'rejected', brokerOrderId: 'O1',
    }));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('marked REJECTED'))).toBe(true);
    expect(alert).toHaveBeenCalledWith('ai-exit-resolve:r1:REJECTED', expect.stringContaining('STILL OPEN'));
    noOrderCalls(session);
  });

  it('not found + position intact on 2 checks ≥ 30 s apart ⇒ FAILED: ORDER_NOT_FOUND (unblocked); never an order call', async () => {
    const { r, repo, session } = make();
    await r.runOnce(CFG, T1);
    expect(repo.resolveUncertain).not.toHaveBeenCalled(); // one check is not enough
    await r.runOnce(CFG, T2);
    expect(repo.resolveUncertain).toHaveBeenCalledTimes(1);
    const [id, from, patch] = repo.resolveUncertain.mock.calls[0] as unknown as [string, string, { reason: string; brokerMessage: string; status?: string }];
    expect([id, from, patch.reason, patch.status]).toEqual(['r1', 'ORDER_UNCERTAIN', ORDER_NOT_FOUND, undefined]);
    expect(patch.brokerMessage.startsWith('no definitive broker answer: {} | resolver ')).toBe(true);
    expect(patch.brokerMessage).toContain(`no order with tag ${TAG}`);
    expect(alert).toHaveBeenCalledWith('ai-exit-resolve:r1:NOT_PLACED', expect.stringContaining('never placed'));
    expect(session.getOrderBookEnvelope).toHaveBeenCalledTimes(2);
    expect(session.getPositionsEnvelope).toHaveBeenCalledTimes(2);
    noOrderCalls(session);
  });

  it('not found once ⇒ still blocked (no write), and a second sweep < 30 s later does not even read', async () => {
    const { r, repo, session } = make();
    await r.runOnce(CFG, T1);
    await r.runOnce(CFG, new Date(T1.getTime() + UNCERTAIN_RECHECK_GAP_MS - 1));
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
    expect(session.getOrderBookEnvelope).toHaveBeenCalledTimes(1);
  });

  it('too soon after the send ⇒ nothing concluded even on repeated checks', async () => {
    const { r, repo } = make();
    await r.runOnce(CFG, new Date(SENT.getTime() + 20_000));
    await r.runOnce(CFG, new Date(SENT.getTime() + 55_000));
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
  });

  it('position reduced ⇒ still blocked: no write, one loud WARN + one alert (not repeated on later sweeps)', async () => {
    const reduced = { status: true, data: [{ ...POSITIONS.data[0], netqty: '10' }] };
    const { r, repo, session } = make({ positions: reduced });
    await r.runOnce(CFG, T1);
    await r.runOnce(CFG, T2);
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('ai-exit-resolve:r1:POSITION_CHANGED', expect.stringContaining('STAY BLOCKED'));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('STAY BLOCKED'))).toHaveLength(1);
    noOrderCalls(session);
  });

  it('position gone ⇒ still blocked', async () => {
    const { r, repo } = make({ positions: { status: true, data: [] } });
    await r.runOnce(CFG, T1);
    await r.runOnce(CFG, T2);
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('ai-exit-resolve:r1:POSITION_CHANGED', expect.stringContaining('flat'));
  });

  it('reads unanswered ⇒ no change; an unanswered read between two "not found" checks does not reset them', async () => {
    for (const [book, positions] of [[{}, POSITIONS], [{ status: false, message: 'x' }, POSITIONS], [EMPTY_BOOK, {}], [[], POSITIONS]] as const) {
      const { r, repo } = make({ book, positions });
      await r.runOnce(CFG, T1);
      await r.runOnce(CFG, T2);
      expect(repo.resolveUncertain).not.toHaveBeenCalled();
    }
    const { r, repo, session } = make();
    await r.runOnce(CFG, T1); // not found #1
    session.getOrderBookEnvelope.mockResolvedValueOnce({});
    await r.runOnce(CFG, T2); // unanswered: nothing
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
    await r.runOnce(CFG, new Date(T2.getTime() + UNCERTAIN_RECHECK_GAP_MS)); // not found #2
    expect(repo.resolveUncertain).toHaveBeenCalledWith('r1', 'ORDER_UNCERTAIN', expect.objectContaining({ reason: ORDER_NOT_FOUND }));
  });

  it('a positions read is not made when the book did not answer; a thrown read is "unanswered"', async () => {
    const { r, session, repo } = make({ book: {} });
    await r.runOnce(CFG, T1);
    expect(session.getPositionsEnvelope).not.toHaveBeenCalled();
    session.getOrderBookEnvelope.mockRejectedValue(new Error('Angel One getOrderBook timed out after 15000ms'));
    await r.runOnce(CFG, T2);
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
  });

  it('no warm session ⇒ the row waits (never logs in); the sweep never throws', async () => {
    const { r, repo, sessions } = make();
    sessions.withOwnerSession.mockRejectedValue(new Error('Owner has no feed session'));
    await expect(r.runOnce(CFG, T1)).resolves.toBeUndefined();
    await expect(r.runOnce(CFG, T2)).resolves.toBeUndefined();
    expect(repo.resolveUncertain).not.toHaveBeenCalled();
    repo.uncertainSince.mockRejectedValueOnce(new Error('db down'));
    await expect(r.runOnce(CFG, new Date(T2.getTime() + 60_000))).resolves.toBeUndefined();
  });

  it('INTERRUPTED rows are resolved the same way (moved only from INTERRUPTED)', async () => {
    const { r, repo } = make({ rows: [{ ...ROW, reason: 'INTERRUPTED', orderSentAt: null }] });
    await r.runOnce(CFG, T1);
    await r.runOnce(CFG, T2);
    expect(repo.resolveUncertain).toHaveBeenCalledWith('r1', 'INTERRUPTED', expect.objectContaining({ reason: ORDER_NOT_FOUND }));
  });

  it('a row moved by someone else meanwhile is not alerted as resolved', async () => {
    const { r, repo } = make();
    repo.resolveUncertain.mockResolvedValue(false);
    await r.runOnce(CFG, T1);
    await r.runOnce(CFG, T2);
    expect(alert).not.toHaveBeenCalled();
  });

  it(`checks at most ${UNCERTAIN_PER_SWEEP} rows per sweep (bounded broker reads)`, async () => {
    const rows = Array.from({ length: UNCERTAIN_PER_SWEEP + 3 }, (_, i) => ({ ...ROW, id: `r${i}` }));
    const { r, session } = make({ rows });
    await r.runOnce(CFG, T1);
    expect(session.getOrderBookEnvelope).toHaveBeenCalledTimes(UNCERTAIN_PER_SWEEP);
    await r.runOnce(CFG, new Date(T1.getTime() + 1_000)); // the rest are due; the first five are not
    expect(session.getOrderBookEnvelope).toHaveBeenCalledTimes(UNCERTAIN_PER_SWEEP + 3);
  });
});
