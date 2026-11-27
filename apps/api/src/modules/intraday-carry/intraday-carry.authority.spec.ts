import { Logger } from '@nestjs/common';
import { CloseProductBook } from './close-product-book';
import { parseCarryConfig } from './domain/carry-config';
import { CARRY_EXIT_REASON_PREFIX, CARRY_EXIT_STAMP, IntradayCarryService } from './intraday-carry.service';
import type { RaiseAlarm } from '../exit-authority/exit-authority.tokens';

/**
 * Trade agent exit authority on the close decision: with the authority live, a CODE exit (EXPIRY_DAY, NO_JUDGEMENT,
 * CARRY not confirmed) raises a `deadline` CARRY alarm on the broker's MIS square-off instead of an EXIT_NOW; the
 * judge's own close verdict is unchanged. Off ⇒ exactly as before.
 */
const ist = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 10, 4, h, m, s) - 5.5 * 3_600_000);
const SYMBOL = 'NIFTY11NOV2524000CE';
const tracker = { id: 'trk1', userId: 'owner', symbol: SYMBOL, exchange: 'NFO', token: '123', qty: 75 };
const row = (producttype: string) => ({ exchange: 'NFO', symboltoken: '123', tradingsymbol: SYMBOL, producttype, netqty: '75', ltp: '100', lotsize: '75' });
const closeLook = (verdict: string) => ({ id: 'v1', verdict, reason: 'trend broken', packet: { squareOffDecision: { closeChoice: 'CARRY_OR_EXIT' }, money: { netPnl: 120 } } });

function harness(opts: { book: () => Record<string, unknown>[]; verdict: string | null; live?: boolean; expiry?: Date }) {
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
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => Object.assign([...rows.values()].find((x) => x.id === id)!, patch)),
    forDay: jest.fn(async (trackerId: string, day: string) => rows.get(`${trackerId}|${day}`) ?? null),
  };
  const session = { getPositionsEnvelope: jest.fn(async () => ({ status: true, data: opts.book() })), convertPosition: jest.fn(async () => ({ accepted: true, message: 'SUCCESS' })) };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: (s: unknown) => Promise<unknown>) => fn(session)) };
  const verdicts = { record: jest.fn(async () => ({ id: 'exit-v' })) };
  const execRepo = { countCountedSince: jest.fn(async () => 0) };
  const prisma = {
    tradeTracker: { findMany: jest.fn(async () => [tracker]) },
    sentinelVerdict: { findMany: jest.fn(async () => (opts.verdict ? [closeLook(opts.verdict)] : [])), findFirst: jest.fn(async () => null) },
    paperSentinelLook: { findMany: jest.fn(async () => []) },
    instrument: { findFirst: jest.fn(async () => ({ expiry: opts.expiry ?? new Date(Date.UTC(2026, 10, 11)) })) },
    trade: { findMany: jest.fn(async () => []), update: jest.fn() },
  };
  const clock = { minutesToClose: (_ex: string, at: Date) => 15 * 60 + 30 - Math.floor((at.getTime() + 5.5 * 3_600_000) / 60_000) % 1440 };
  const book = new CloseProductBook(parseCarryConfig(process.env));
  const raise = jest.fn(async (a: RaiseAlarm) => ({ id: 'al-c', ...a }));
  const authority = { isLive: () => opts.live !== false };
  const svc = new IntradayCarryService(
    prisma as never, repo as never, book, sessions as never, verdicts as never, execRepo as never, clock, undefined,
    { raise, openFor: jest.fn(), openForTrackers: jest.fn(), answer: jest.fn() } as never, authority,
  );
  process.env = prev;
  return { svc, rows, session, verdicts, raise };
}

const SQUARE_OFF = ist(15, 15);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('IntradayCarryService — exit authority (live)', () => {
  it('NO_JUDGEMENT: a deadline CARRY alarm at the 15:15 square-off, no EXIT_NOW', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: null });
    await h.svc.runOnce(ist(15, 9));
    expect(h.verdicts.record).not.toHaveBeenCalled();
    expect(h.raise).toHaveBeenCalledTimes(1);
    const a = h.raise.mock.calls[0][0];
    expect(a).toMatchObject({ userId: 'owner', trackerId: 'trk1', rule: 'CARRY', urgency: 'deadline', deadline: SQUARE_OFF });
    expect(a.reason).toMatch(/^NO_JUDGEMENT/);
    expect(a.wouldHave).toContain(`EXIT_NOW ${CARRY_EXIT_REASON_PREFIX} NO_JUDGEMENT`);
    expect([...h.rows.values()][0]).toMatchObject({ decision: 'EXIT' });
  });

  it('EXPIRY_DAY: the same', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'HOLD', expiry: new Date(Date.UTC(2026, 10, 4)) });
    await h.svc.runOnce(ist(15, 6));
    expect(h.verdicts.record).not.toHaveBeenCalled();
    expect(h.raise.mock.calls[0][0]).toMatchObject({ rule: 'CARRY', urgency: 'deadline', deadline: SQUARE_OFF });
    expect(h.raise.mock.calls[0][0].reason).toMatch(/^EXPIRY_DAY/);
  });

  it('CARRY not confirmed by the book: the fallback EXIT becomes the alarm', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'HOLD' });
    await h.svc.runOnce(ist(15, 6));
    await h.svc.runOnce(ist(15, 6, 40));
    await h.svc.runOnce(ist(15, 12));
    expect(h.verdicts.record).not.toHaveBeenCalled();
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.raise.mock.calls[0][0].reason).toMatch(/^CARRY not confirmed/);
    expect(h.raise.mock.calls[0][0].deadline).toEqual(SQUARE_OFF);
  });

  it('the judge\'s own EXIT (an LLM verdict) is unchanged: EXIT_NOW recorded, no alarm', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: 'EXIT_NOW' });
    await h.svc.runOnce(ist(15, 6));
    expect(h.raise).not.toHaveBeenCalled();
    expect(h.verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'EXIT_NOW', promptVersion: CARRY_EXIT_STAMP }));
  });

  it('off: a code exit records the EXIT_NOW exactly as today', async () => {
    const h = harness({ book: () => [row('INTRADAY')], verdict: null, live: false });
    await h.svc.runOnce(ist(15, 9));
    expect(h.raise).not.toHaveBeenCalled();
    expect(h.verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'EXIT_NOW', promptVersion: CARRY_EXIT_STAMP }));
  });
});
