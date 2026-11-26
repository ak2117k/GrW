import { DeskDayRepository } from './desk-day.repository';

type Row = { id: string; userId: string; symbol: string; kind: string; status: string; entryPrice: number; exitPrice: number | null; qty: number; exitTime: Date | null; pnl: number | null };

const NOW = new Date('2026-11-26T08:00:00Z'); // 13:30 IST
const IST_MIDNIGHT = new Date('2026-11-25T18:30:00Z');

/** A tiny in-memory prisma that honours the where clauses the repository sends. */
function make(trackers: Row[], orders: Array<{ trackerId: string; source: string | null }> = [], state: Record<string, unknown> | null = null) {
  const match = (r: Row, w: any) =>
    r.userId === w.userId &&
    r.kind === w.kind &&
    r.status === w.status &&
    !(w.NOT?.id?.startsWith && r.id.startsWith(w.NOT.id.startsWith)) &&
    (!w.exitTime || (r.exitTime !== null && r.exitTime >= w.exitTime.gte && r.exitTime <= w.exitTime.lte));
  const prisma = {
    tradeTracker: {
      findMany: jest.fn(async ({ where }: any) => trackers.filter((r) => match(r, where)).sort((a, b) => a.exitTime!.getTime() - b.exitTime!.getTime())),
      aggregate: jest.fn(async ({ where }: any) => {
        const rs = trackers.filter((r) => match(r, where));
        return { _sum: { pnl: rs.length ? rs.reduce((s, r) => s + (r.pnl ?? 0), 0) : null } };
      }),
    },
    signalOrder: { findMany: jest.fn(async ({ where }: any) => orders.filter((o) => where.trackerId.in.includes(o.trackerId))) },
    deskGuardState: {
      findUnique: jest.fn(async () => state),
      upsert: jest.fn(async ({ create, update }: any) => (state = { ...(state ?? create), ...update })),
    },
    deskGuardEvent: { create: jest.fn(async () => ({})) },
  };
  return { repo: new DeskDayRepository(prisma as never), prisma };
}

const closed = (id: string, exitTime: Date, pnl: number, over: Partial<Row> = {}): Row => ({
  id, userId: 'owner', symbol: 'NIFTY02DEC2625000CE', kind: 'POSITION', status: 'CLOSED', entryPrice: 100, exitPrice: 90, qty: 75, exitTime, pnl, ...over,
});

describe('DeskDayRepository', () => {
  it('counts a manual tracker (no signal_orders row → origin manual, included)', async () => {
    const { repo } = make(
      [closed('t1', new Date('2026-11-26T04:00:00Z'), -1200), closed('t2', new Date('2026-11-26T05:00:00Z'), -800)],
      [{ trackerId: 't2', source: 'signal' }],
    );
    const out = await repo.closedToday('owner', NOW);
    expect(out.map((t) => [t.trackerId, t.origin, t.pnl])).toEqual([['t1', 'manual', -1200], ['t2', 'signal', -800]]);
    expect(out[0].underlying).toBe('NIFTY');
  });

  it('maps reentry / manager sources, and a null source on an existing order row is the signal trader', async () => {
    const { repo } = make(
      [closed('a', new Date('2026-11-26T04:00:00Z'), 1), closed('b', new Date('2026-11-26T04:10:00Z'), 2), closed('c', new Date('2026-11-26T04:20:00Z'), 3)],
      [{ trackerId: 'a', source: 'reentry' }, { trackerId: 'b', source: 'manager' }, { trackerId: 'c', source: null }],
    );
    expect((await repo.closedToday('owner', NOW)).map((t) => t.origin)).toEqual(['reentry', 'manager', 'signal']);
  });

  it('excludes paper: trackers', async () => {
    const { repo } = make([closed('paper:x', new Date('2026-11-26T04:00:00Z'), -5000), closed('t1', new Date('2026-11-26T04:00:00Z'), -100)]);
    expect((await repo.closedToday('owner', NOW)).map((t) => t.trackerId)).toEqual(['t1']);
  });

  it('excludes HOLDING rows and other users', async () => {
    const { repo } = make([
      closed('h', new Date('2026-11-26T04:00:00Z'), -9000, { kind: 'HOLDING' }),
      closed('o', new Date('2026-11-26T04:00:00Z'), -9000, { userId: 'someone' }),
    ]);
    expect(await repo.closedToday('owner', NOW)).toEqual([]);
  });

  it('IST day boundary (closed 23:50 IST yesterday excluded, 00:05 IST today included)', async () => {
    const { repo, prisma } = make([
      closed('y', new Date('2026-11-25T18:20:00Z'), -3000), // 23:50 IST 25th
      closed('t', new Date('2026-11-25T18:35:00Z'), -100), // 00:05 IST 26th
    ]);
    expect((await repo.closedToday('owner', NOW)).map((t) => t.trackerId)).toEqual(['t']);
    expect(prisma.tradeTracker.findMany.mock.calls[0][0].where.exitTime.gte).toEqual(IST_MIDNIGHT);
  });

  it('resetAt excludes earlier closes', async () => {
    const resetAt = new Date('2026-11-26T06:00:00Z');
    const { repo } = make(
      [closed('before', new Date('2026-11-26T05:00:00Z'), -4000), closed('after', new Date('2026-11-26T07:00:00Z'), -100)],
      [],
      { userId: 'owner', day: '2026-11-26', pausedUntil: null, pauseScope: null, resetAt },
    );
    expect((await repo.closedToday('owner', NOW)).map((t) => t.trackerId)).toEqual(['after']);
  });

  it('a reset from an earlier IST day is ignored', async () => {
    const { repo } = make([closed('t', new Date('2026-11-26T05:00:00Z'), -400)], [], { userId: 'owner', day: '2026-11-25', pausedUntil: null, pauseScope: null, resetAt: new Date('2026-11-26T07:00:00Z') });
    expect((await repo.closedToday('owner', NOW)).map((t) => t.trackerId)).toEqual(['t']);
    expect(await repo.guardDay('owner', NOW)).toEqual({ pausedUntil: null, pauseScope: null, resetAt: null });
  });

  it('a closed row with no stored pnl is priced from its exit, never 0', async () => {
    const { repo } = make([closed('t', new Date('2026-11-26T05:00:00Z'), null as never, { entryPrice: 100, exitPrice: 90, qty: 75 })]);
    expect((await repo.closedToday('owner', NOW))[0].pnl).toBe(-750);
  });

  it('openPnl sums open live position trackers only', async () => {
    const open = (id: string, pnl: number, over: Partial<Row> = {}) => ({ ...closed(id, null as never, pnl), status: 'OPEN', exitTime: null, ...over });
    const { repo } = make([open('a', -300), open('b', 100), open('paper:p', -9999), open('h', -9999, { kind: 'HOLDING' })]);
    expect(await repo.openPnl('owner', NOW)).toBe(-200);
    expect(await make([]).repo.openPnl('owner', NOW)).toBe(0);
  });

  it('reset clears the pause and stamps resetAt', async () => {
    const { repo, prisma } = make([], [], { userId: 'owner', day: '2026-11-26', pausedUntil: new Date('2026-11-26T09:00:00Z'), pauseScope: 'all', resetAt: null });
    await repo.saveReset('owner', NOW);
    expect(prisma.deskGuardState.upsert.mock.calls[0][0].update).toEqual({ day: '2026-11-26', pausedUntil: null, pauseScope: null, resetAt: NOW });
  });
});
