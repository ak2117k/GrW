import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Bar15m } from '../../ai-setups/domain/setup-watch';
import { DESK_GRADE_CRON, DESK_GRADE_LOOKBACK_MS, DeskGradeCron, type DeskGradeMarket } from './desk-grade.cron';

const IST = (hhmm: string, day = '2026-11-24') => new Date(`${day}T${hhmm}:00+05:30`);
const NIGHT = IST('23:45');

function flat(from: string, to: string, px: number): Bar15m[] {
  const out: Bar15m[] = [];
  for (let t = IST(from).getTime(); t < IST(to).getTime(); t += 15 * 60_000) out.push({ ts: t, open: px, high: px + 1, low: px - 1, close: px });
  return out;
}

interface DecisionRow {
  id: string; runId: string; userId: string; action: string; status: string; underlying: string | null; trackerId: string | null;
  payload: unknown; tradeId: string | null; orderRowId: string | null; grade: unknown; createdAt: Date;
}

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: 'd1', runId: 'r1', userId: 'u1', action: 'OPEN', status: 'DONE', underlying: 'NIFTY', trackerId: null,
    payload: { action: 'OPEN', side: 'BUY_CE', stop: { underlying: 24000 }, targets: { underlying: [24100] } },
    tradeId: null, orderRowId: 'o1', grade: null, createdAt: IST('10:02'), ...over,
  };
}

function harness(rows: DecisionRow[], opts: { tracker?: Record<string, unknown> | null; bars?: Bar15m[] | Error } = {}) {
  const isNullGrade = (w: { grade?: { equals?: unknown } }) => w.grade?.equals === Prisma.AnyNull;
  const prisma = {
    deskManagerDecision: {
      findMany: jest.fn(async ({ where }: { where: { grade: { equals: unknown }; createdAt: { gte: Date } } }) =>
        rows.filter((r) => (isNullGrade(where) ? r.grade === null : true) && r.createdAt >= where.createdAt.gte)),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; grade: { equals: unknown } }; data: { grade: unknown } }) => {
        const r = rows.find((x) => x.id === where.id && (!isNullGrade(where) || x.grade === null));
        if (!r) return { count: 0 };
        r.grade = data.grade;
        return { count: 1 };
      }),
      findFirst: jest.fn(async () => ({ underlying: 'NIFTY' })),
    },
    deskManagerPendingEntry: { findUnique: jest.fn(async () => null) },
    signalOrder: { findUnique: jest.fn(async () => ({ trackerId: 'k1' })) },
    tradeTracker: {
      findUnique: jest.fn(async () =>
        opts.tracker === undefined
          ? { id: 'k1', status: 'CLOSED', symbol: 'NIFTY25NOV2424050CE', exchange: 'NFO', kind: 'POSITION', entryPrice: 100, exitPrice: 140, qty: 75, entryTime: IST('10:05'), exitTime: IST('11:05'), pnl: 3000 }
          : opts.tracker),
    },
    trade: { findUnique: jest.fn(async () => null) },
    deskManagerRun: { findUnique: jest.fn(async () => null) },
    deskGuardEvent: { findMany: jest.fn(async () => []) },
  };
  const market: jest.Mocked<DeskGradeMarket> = {
    underlyingRef: jest.fn(async () => ({ exchange: 'NSE', token: '99926000', symbol: 'Nifty 50' })),
    bars15m: jest.fn(async () => {
      if (opts.bars instanceof Error) throw opts.bars;
      return opts.bars ?? [...flat('10:00', '10:30', 24040), ...flat('10:30', '10:45', 24105), ...flat('10:45', '12:00', 24080)];
    }),
  };
  const cron = new DeskGradeCron(prisma as never, market, undefined, () => NIGHT);
  return { cron, prisma, market, rows };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('DeskGradeCron', () => {
  it('runs at 23:45 IST on weekdays', () => {
    expect(DESK_GRADE_CRON).toBe('45 23 * * 1-5');
  });

  it('grades a closed live OPEN via its signal order → tracker, net of estimated charges', async () => {
    const h = harness([decision()]);
    const r = await h.cron.grade(NIGHT);
    expect(r.graded).toBe(1);
    const g = h.rows[0].grade as { kind: string; pnl: number; netPnl: number; hit: string };
    expect(g).toMatchObject({ kind: 'OPEN', pnl: 3000, hit: 'TARGET' });
    expect(g.netPnl).toBeLessThan(3000);
    expect(g.netPnl).toBeGreaterThan(2800);
    expect(h.prisma.signalOrder.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1' } }));
    expect(h.market.bars15m).toHaveBeenCalled();
  });

  it('reads only ungraded rows of the last 7 days', async () => {
    const h = harness([decision({ id: 'old', createdAt: new Date(NIGHT.getTime() - DESK_GRADE_LOOKBACK_MS - 60_000) }), decision({ id: 'new' })]);
    await h.cron.grade(NIGHT);
    expect(h.prisma.deskManagerDecision.findMany.mock.calls[0][0].where.grade).toEqual({ equals: Prisma.AnyNull });
    expect(h.rows.find((r) => r.id === 'old')!.grade).toBeNull();
    expect(h.rows.find((r) => r.id === 'new')!.grade).not.toBeNull();
  });

  it('re-run does not overwrite an existing grade', async () => {
    const prior = { kind: 'OPEN', note: 'first night' };
    const h = harness([decision({ grade: prior })]);
    const r = await h.cron.grade(NIGHT);
    expect(r.graded).toBe(0);
    expect(h.rows[0].grade).toBe(prior);
    // A row graded by another instance between read and write: the conditional update writes nothing.
    const h2 = harness([decision()]);
    h2.prisma.deskManagerDecision.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await h2.cron.grade(NIGHT)).graded).toBe(0);
    expect(h2.prisma.deskManagerDecision.updateMany.mock.calls[0][0].where).toEqual({ id: 'd1', grade: { equals: Prisma.AnyNull } });
  });

  it('a trade still open stays ungraded (retried next night)', async () => {
    const h = harness([decision()], { tracker: { id: 'k1', status: 'OPEN', symbol: 'X25NOV100CE', exchange: 'NFO', kind: 'POSITION', entryPrice: 100, exitPrice: null, qty: 75, entryTime: IST('10:05'), exitTime: null, pnl: null } });
    const r = await h.cron.grade(NIGHT);
    expect(r).toMatchObject({ graded: 0, notReady: 1 });
    expect(h.prisma.deskManagerDecision.updateMany).not.toHaveBeenCalled();
  });

  it('the bar loader failing → graded with null bar fields and the reason, never a throw', async () => {
    const h = harness([decision()], { bars: new Error('hub timeout') });
    const r = await h.cron.grade(NIGHT);
    expect(r.graded).toBe(1);
    expect(h.rows[0].grade).toMatchObject({ kind: 'OPEN', pnl: 3000, mfe: null, hit: null });
    expect((h.rows[0].grade as { note: string }).note).toContain('hub timeout');
  });

  it('EXIT finds its underlying from the OPEN on the same tracker; one bad row does not stop the run', async () => {
    const h = harness([
      decision({ id: 'bad' }),
      decision({ id: 'x1', action: 'EXIT', underlying: null, trackerId: 'k1', payload: { action: 'EXIT', trackerId: 'k1' }, orderRowId: null }),
    ]);
    h.prisma.signalOrder.findUnique.mockRejectedValueOnce(new Error('db blip'));
    const r = await h.cron.grade(NIGHT);
    expect(r).toMatchObject({ graded: 1, failed: 1 });
    expect(h.prisma.deskManagerDecision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { trackerId: 'k1', underlying: { not: null } } }));
    expect(h.rows.find((x) => x.id === 'x1')!.grade).toMatchObject({ kind: 'EXIT' });
  });

  it('NO_ACTION reads the proposal from its run packet', async () => {
    const h = harness([decision({ id: 'n1', action: 'NO_ACTION', status: 'VALID', orderRowId: null, payload: { action: 'NO_ACTION', proposalRef: 'p1' } })], {
      bars: [...flat('10:00', '10:15', 24030), ...flat('10:15', '15:30', 24200)],
    });
    h.prisma.deskManagerRun.findUnique.mockResolvedValueOnce({
      packet: { proposals: { status: 'present', source: 'x', value: [{ ref: 'p1', kind: 'reading', at: '', underlying: 'NIFTY', text: '', detail: { sl: 24000, target: 24150 } }] } },
    } as never);
    await h.cron.grade(NIGHT);
    expect(h.rows[0].grade).toMatchObject({ kind: 'NO_ACTION', hit: 'TARGET' });
  });

  it('PAUSE counts blocked guard events inside its window', async () => {
    const h = harness([decision({ id: 'p1', action: 'PAUSE_ENTRIES', orderRowId: null, payload: { action: 'PAUSE_ENTRIES', scope: 'all', minutes: 30 }, createdAt: IST('11:00') })]);
    h.prisma.deskGuardEvent.findMany.mockResolvedValueOnce([{ at: IST('11:10'), reasons: ['paused all'] }] as never);
    await h.cron.grade(NIGHT);
    expect(h.prisma.deskGuardEvent.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: 'u1', blocked: true, at: { gte: IST('11:00'), lt: IST('11:30') } } });
    expect(h.rows[0].grade).toMatchObject({ kind: 'PAUSE', blocked: 1 });
  });
});
