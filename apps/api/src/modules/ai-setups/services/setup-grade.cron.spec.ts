import { Logger } from '@nestjs/common';
import type { SetupPlan } from '../domain/setup.types';
import type { Bar15m } from '../domain/setup-watch';
import type { GradeTrade } from '../domain/setup-grade';
import type { GradeCandidateRow } from '../repositories/ai-setups.repository';
import { SETUP_GRADE_MCX_CRON, SETUP_GRADE_NSE_CRON, SetupGradeCron, type SetupGradeMarket, type SetupGradeStore } from './setup-grade.cron';

const IST = (hhmm: string, day = '2026-11-24') => new Date(`${day}T${hhmm}:00+05:30`);
const NIGHT = IST('18:40');

function flat(from: string, to: string, px: number, day = '2026-11-24'): Bar15m[] {
  const out: Bar15m[] = [];
  for (let t = IST(from, day).getTime(); t < IST(to, day).getTime(); t += 15 * 60_000) out.push({ ts: t, open: px, high: px + 0.5, low: px - 0.5, close: px });
  return out;
}

const plan: SetupPlan = {
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 430, optionType: 'CE', expiry: '2026-12-29' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 426, trigger: null, level: null },
  sl: 420,
  targets: [432, 436],
  validUntil: '12:00',
  confidence: 70,
  evidence: [],
};

function row(over: Partial<GradeCandidateRow> = {}): GradeCandidateRow {
  return {
    id: 's1',
    underlying: 'DABUR',
    decision: 'SETUP',
    status: 'EXITED',
    setup: plan,
    checks: { context: { ltpUnderlying: 431, delta: 0.5, lotSize: 1250, exchange: 'NFO' } },
    packet: { optionExchange: 'NFO' },
    tradeId: 't1',
    validUntil: IST('12:00'),
    createdAt: IST('10:05'),
    exitReason: 'AI_SETUP_SL',
    pnl: -2000,
    grade: null,
    updatedAt: IST('11:00'),
    ...over,
  };
}

/** 10:15 fills at 426 and stops at 420. */
const LOSS_BARS = [...flat('10:00', '10:15', 430), { ts: IST('10:15').getTime(), open: 430, high: 431, low: 419, close: 421 }, ...flat('10:30', '15:30', 421)];

function harness(rows: GradeCandidateRow[], opts: { bars?: Bar15m[] | Error; tradingDay?: boolean; trade?: GradeTrade | null; prior?: unknown[] } = {}) {
  const written = new Map<string, unknown>();
  const store: jest.Mocked<SetupGradeStore> = {
    gradeCandidates: jest.fn(async (_s: Date, _u: Date) => rows.filter((r) => !written.has(r.id) || (written.get(r.id) as { status: string }).status === 'PENDING')),
    writeGrade: jest.fn(async (id: string, _u: Date, g: unknown) => {
      written.set(id, g);
      return true;
    }),
    gradeTrade: jest.fn(async (_id: string) => (opts.trade === undefined ? { id: 't1', status: 'CLOSED', pnl: -2000, fees: 75, exitReasonTag: 'AI_SETUP_SL', isPaperTrade: true } : opts.trade)),
    gradedSetupGrades: jest.fn(async () => [...(opts.prior ?? []), ...written.values()]),
  };
  const market: jest.Mocked<SetupGradeMarket> = {
    underlyingRef: jest.fn(async (u: string, _at: Date): Promise<{ exchange: string; token: string; symbol: string } | null> => ({ exchange: 'NSE', token: '772', symbol: u })),
    bars15m: jest.fn(async (_r: { exchange: string; token: string; symbol: string }, _f: Date, _n: Date): Promise<Bar15m[]> => {
      if (opts.bars instanceof Error) throw opts.bars;
      return opts.bars ?? LOSS_BARS;
    }),
  };
  const clock = { isTradingDay: jest.fn(() => opts.tradingDay ?? true) };
  const lease = { runExclusiveFailClosed: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn()) };
  const cron = new SetupGradeCron(store, market, clock, lease as never, () => NIGHT);
  return { cron, store, market, clock, lease, written };
}

describe('SetupGradeCron', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delete process.env.BOOT_JOBS;
  });
  afterEach(() => jest.restoreAllMocks());

  it('schedules 18:40 (NSE) and 23:45 (MCX) on weekdays', () => {
    expect(SETUP_GRADE_NSE_CRON).toBe('40 18 * * 1-5');
    expect(SETUP_GRADE_MCX_CRON).toBe('45 23 * * 1-5');
  });

  it('NSE night: grades the session setup under the lease and logs the summary with the gate totals', async () => {
    const h = harness([row()], { prior: [{ status: 'GRADED', kind: 'SETUP', actual: { net: 500 } }] });
    await h.cron.onNse();
    expect(h.lease.runExclusiveFailClosed).toHaveBeenCalledWith('ai-setup-grade-NSE', expect.any(Number), expect.any(Function));
    expect(h.store.writeGrade).toHaveBeenCalledWith('s1', IST('11:00'), expect.objectContaining({ status: 'GRADED', kind: 'SETUP' }));
    expect(h.written.get('s1')).toMatchObject({ actual: { net: -2075, filled: true }, plan: { outcome: 'SL', points: -6, rupees: -3750 } });
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[ai-setup-grade]'));
    expect(line).toMatch(/setups graded 1, filled 1, actual net ₹-2075, plan-only net ₹-3750/);
    expect(line).toMatch(/live gate: 2\/20 graded setups, cumulative actual net ₹-1575/);
  });

  it('idempotent: a second run finds nothing to grade and writes nothing', async () => {
    const h = harness([row()]);
    await h.cron.onNse();
    await h.cron.onNse();
    expect(h.store.writeGrade).toHaveBeenCalledTimes(1);
  });

  it('a lost conditional write (row changed meanwhile) is not counted as graded', async () => {
    const h = harness([row()]);
    h.store.writeGrade.mockResolvedValueOnce(false);
    await h.cron.onNse();
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[ai-setup-grade]'));
    expect(line).toMatch(/setups graded 0/);
  });

  it('missing bars → PENDING grade (not graded), with the reason', async () => {
    const h = harness([row()], { bars: new Error('no 15m bar loader') });
    await h.cron.onNse();
    expect(h.written.get('s1')).toMatchObject({ status: 'PENDING', reason: expect.stringContaining('no 15m bar loader'), sessionsTried: ['2026-11-24'] });
  });

  it('NO_TRADE rows get a what-if; MCX rows wait for the MCX cron', async () => {
    const veto = row({ id: 'v1', status: 'NO_TRADE', tradeId: null, validUntil: null, pnl: null });
    const mcx = row({ id: 'm1', underlying: 'CRUDEOIL', packet: { optionExchange: 'MCX' }, checks: { context: { exchange: 'MCX' } } });
    const h = harness([veto, mcx]);
    await h.cron.onNse();
    expect(h.written.get('v1')).toMatchObject({ status: 'GRADED', kind: 'NO_TRADE_VETOED', whatIf: { hypothetical: true, outcome: 'SL' } });
    expect(h.written.has('m1')).toBe(false);
    expect(h.store.gradeTrade).not.toHaveBeenCalledWith(undefined);
  });

  it('MCX night grades MCX rows only', async () => {
    const mcx = row({ id: 'm1', underlying: 'CRUDEOIL', packet: { optionExchange: 'MCX' }, checks: { context: { exchange: 'MCX' } } });
    const h = harness([row(), mcx]);
    await h.cron.onMcx();
    expect(h.lease.runExclusiveFailClosed).toHaveBeenCalledWith('ai-setup-grade-MCX', expect.any(Number), expect.any(Function));
    expect([...h.written.keys()]).toEqual(['m1']);
  });

  it('bars are read once per underlying per session day', async () => {
    const h = harness([row({ id: 'a' }), row({ id: 'b', status: 'NO_TRADE', tradeId: null })]);
    await h.cron.onNse();
    expect(h.market.bars15m).toHaveBeenCalledTimes(1);
  });

  it('not a trading day, or BOOT_JOBS=false → nothing', async () => {
    const h = harness([row()], { tradingDay: false });
    await h.cron.onNse();
    expect(h.store.gradeCandidates).not.toHaveBeenCalled();
    process.env.BOOT_JOBS = 'false';
    const h2 = harness([row()]);
    await h2.cron.onNse();
    expect(h2.store.gradeCandidates).not.toHaveBeenCalled();
  });

  it('a store failure is logged, never thrown', async () => {
    const h = harness([row()]);
    h.store.gradeCandidates.mockRejectedValueOnce(new Error('db down'));
    await expect(h.cron.onNse()).resolves.toBeUndefined();
  });
});
