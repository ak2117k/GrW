import { CloseProductBook } from './close-product-book';
import { parseCarryConfig } from './domain/carry-config';
import { CARRY_EXIT_STAMP, IntradayCarryService } from './intraday-carry.service';

/** 2026-11-04 at hh:mm:ss IST. */
const ist = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 10, 4, h, m, s) - 5.5 * 3_600_000);
const SYMBOL = 'NIFTY11NOV2524000CE';
const tracker = { id: 'trk1', userId: 'owner', symbol: SYMBOL, exchange: 'NFO', token: '123', qty: 75 };
const row = (producttype: string) => ({ exchange: 'NFO', symboltoken: '123', tradingsymbol: SYMBOL, producttype, netqty: '75', ltp: '100', lotsize: '75' });
const closeLook = (verdict: string) => ({
  id: 'v1', verdict, reason: 'trend intact', packet: { squareOffDecision: { closeChoice: 'CARRY_OR_EXIT' }, money: { netPnl: 120 } },
});

function harness(opts: { book: () => Record<string, unknown>[]; verdict: string | null; cap?: number }) {
  const prev = { ...process.env };
  process.env.INTRADAY_CARRY_USERS = 'owner';
  process.env.AI_AUTO_EXIT_ENABLED = 'true';
  process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
  process.env.AI_AUTO_EXIT_QTY_UNITS = 'NFO:units';
  const rows = new Map<string, Record<string, unknown>>();
  const repo = {
    create: jest.fn(async (d: Record<string, unknown>) => {
      const key = `${d.trackerId}|${d.istDay}`;
      if (rows.has(key)) return null;
      const r = { id: `d${rows.size + 1}`, conversionAttempts: 0, updatedAt: new Date(0), ...d };
      rows.set(key, r);
      return r;
    }),
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
      const r = [...rows.values()].find((x) => x.id === id)!;
      Object.assign(r, patch);
      return r;
    }),
    forDay: jest.fn(async (trackerId: string, day: string) => rows.get(`${trackerId}|${day}`) ?? null),
  };
  const session = { getPositionsEnvelope: jest.fn(async () => ({ status: true, data: opts.book() })), convertPosition: jest.fn(async () => ({ accepted: true, message: 'SUCCESS' })) };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: (s: unknown) => Promise<unknown>) => fn(session)) };
  const verdicts = { record: jest.fn(async () => ({ id: 'exit-v' })) };
  const execRepo = { countCountedSince: jest.fn(async () => opts.cap ?? 0) };
  const prisma = {
    tradeTracker: { findMany: jest.fn(async () => [tracker]) },
    sentinelVerdict: { findMany: jest.fn(async () => (opts.verdict ? [closeLook(opts.verdict)] : [])), findFirst: jest.fn(async () => null) },
    paperSentinelLook: { findMany: jest.fn(async () => []) },
    instrument: { findFirst: jest.fn(async () => ({ expiry: new Date(Date.UTC(2026, 10, 11)) })) },
    trade: { findMany: jest.fn(async () => []), update: jest.fn() },
  };
  // NFO closes 15:30: whole minutes to the close, as the session clock counts.
  const clock = { minutesToClose: (_ex: string, at: Date) => 15 * 60 + 30 - Math.floor((at.getTime() + 5.5 * 3_600_000) / 60_000) % 1440 };
  const book = new CloseProductBook(parseCarryConfig(process.env));
  const svc = new IntradayCarryService(prisma as never, repo as never, book, sessions as never, verdicts as never, execRepo as never, clock);
  process.env = prev;
  return { svc, repo, rows, session, verdicts, book };
}

describe('IntradayCarryService — live close decision (Review Focus 1: "converted" but the book says MIS)', () => {
  it('CARRY: converts, and the book confirming carry-forward closes the decision', async () => {
    let product = 'INTRADAY';
    const h = harness({ book: () => [row(product)], verdict: 'HOLD' });
    await h.svc.runOnce(ist(15, 6));
    expect(h.session.convertPosition).toHaveBeenCalledTimes(1);
    expect([...h.rows.values()][0]).toMatchObject({ decision: 'CARRY', conversionStatus: 'PENDING', mode: 'live' });
    product = 'CARRYFORWARD';
    await h.svc.runOnce(ist(15, 6, 20));
    expect([...h.rows.values()][0]).toMatchObject({ conversionStatus: 'CONVERTED' });
    expect(h.book.productTypeOf('trk1')).toBe('CARRYFORWARD');
    expect(h.verdicts.record).not.toHaveBeenCalled();
  });

  it('the broker says accepted but the book still says MIS: retry once, then EXIT before the deadline', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'HOLD' });
    await h.svc.runOnce(ist(15, 6));
    await h.svc.runOnce(ist(15, 6, 15)); // NOT_CONVERTED, < RETRY_SEC since the attempt: wait
    expect(h.session.convertPosition).toHaveBeenCalledTimes(1);
    await h.svc.runOnce(ist(15, 6, 40)); // retry
    expect(h.session.convertPosition).toHaveBeenCalledTimes(2);
    await h.svc.runOnce(ist(15, 9)); // re-check only
    expect(h.verdicts.record).not.toHaveBeenCalled();
    await h.svc.runOnce(ist(15, 12)); // 3 min before the 15:15 square-off
    expect(h.verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'EXIT_NOW', promptVersion: CARRY_EXIT_STAMP, trackerId: 'trk1' }));
    expect([...h.rows.values()][0]).toMatchObject({ conversionStatus: 'EXIT_FALLBACK', exitVerdictId: 'exit-v' });
  });

  it('judge EXIT: an EXIT_NOW verdict for the executor, no conversion', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'EXIT_NOW' });
    await h.svc.runOnce(ist(15, 6));
    expect(h.session.convertPosition).not.toHaveBeenCalled();
    expect(h.verdicts.record).toHaveBeenCalledTimes(1);
    expect([...h.rows.values()][0]).toMatchObject({ decision: 'EXIT' });
  });

  it('cap used up + EXIT: CAP_BLOCKED_BROKER_SQUARE_OFF, nothing recorded for the executor', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'EXIT_NOW', cap: 99 });
    await h.svc.runOnce(ist(15, 6));
    expect(h.verdicts.record).not.toHaveBeenCalled();
    expect([...h.rows.values()][0]).toMatchObject({ decision: 'CAP_BLOCKED_BROKER_SQUARE_OFF' });
  });

  it('a carry-forward position is never decided — only its product is cached for the cycle', async () => {
    const h = harness({ book: () => [row('CARRYFORWARD')], verdict: 'HOLD' });
    await h.svc.runOnce(ist(15, 6));
    expect(h.rows.size).toBe(0);
    expect(h.book.productTypeOf('trk1')).toBe('CARRYFORWARD');
  });

  it('no judgement: waits, then EXIT at DECIDE_BY_MIN before the square-off', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: null });
    await h.svc.runOnce(ist(15, 6));
    expect(h.rows.size).toBe(0);
    await h.svc.runOnce(ist(15, 9));
    expect([...h.rows.values()][0]).toMatchObject({ decision: 'EXIT' });
    expect(h.verdicts.record).toHaveBeenCalledTimes(1);
  });
});
