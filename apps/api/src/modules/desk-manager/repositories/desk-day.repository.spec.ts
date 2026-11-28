import { DeskDayRepository } from './desk-day.repository';

type Row = { id: string; userId: string; symbol: string; kind: string; status: string; entryPrice: number; exitPrice: number | null; qty: number; exitTime: Date | null; pnl: number | null; entryTime?: Date | null; exchange?: string; token?: string; lastLtp?: number | null };
type Bar = { exchange: string; token: string; ts: Date; close: number };
type Order = { trackerId: string | null; source: string | null; userId?: string; status?: string; exchange?: string; token?: string; tradingsymbol?: string; createdAt?: Date };

const NOW = new Date('2026-11-26T08:00:00Z'); // 13:30 IST
const IST_MIDNIGHT = new Date('2026-11-25T18:30:00Z');

/** A tiny in-memory prisma that honours the where clauses the repository sends. */
function make(trackers: Row[], orders: Order[] = [], state: Record<string, unknown> | null = null, bars: Bar[] = []) {
  const match = (r: Row, w: any) =>
    r.userId === w.userId &&
    (w.kind === undefined || r.kind === w.kind) &&
    (w.status === undefined || r.status === w.status) &&
    (!w.id?.in || w.id.in.includes(r.id)) &&
    !(w.NOT?.id?.startsWith && r.id.startsWith(w.NOT.id.startsWith)) &&
    (!w.exitTime || (r.exitTime !== null && r.exitTime >= w.exitTime.gte && r.exitTime <= w.exitTime.lte));
  // Two query shapes: linked rows (trackerId in ids) and the contract fallback (user + live status + token/symbol).
  const orderMatch = (o: Order, w: any) =>
    w.trackerId
      ? w.trackerId.in.includes(o.trackerId)
      : (o.userId ?? 'owner') === w.userId &&
        w.status.in.includes(o.status ?? 'FILLED') &&
        (o.createdAt ?? NOW) >= w.createdAt.gte &&
        w.OR.some((c: any) => (c.token && o.token !== undefined && c.token.in.includes(o.token)) || (c.tradingsymbol && o.tradingsymbol !== undefined && c.tradingsymbol.in.includes(o.tradingsymbol)));
  const prisma = {
    tradeTracker: {
      findMany: jest.fn(async ({ where }: any) => trackers.filter((r) => match(r, where)).sort((a, b) => (a.exitTime?.getTime() ?? 0) - (b.exitTime?.getTime() ?? 0))),
      aggregate: jest.fn(async ({ where }: any) => {
        const rs = trackers.filter((r) => match(r, where));
        return { _sum: { pnl: rs.length ? rs.reduce((s, r) => s + (r.pnl ?? 0), 0) : null } };
      }),
    },
    signalOrder: { findMany: jest.fn(async ({ where }: any) => orders.filter((o) => orderMatch(o, where))) },
    deskGuardState: {
      findUnique: jest.fn(async () => state),
      upsert: jest.fn(async ({ create, update }: any) => (state = { ...(state ?? create), ...update })),
    },
    deskGuardEvent: { create: jest.fn(async () => ({})) },
    // prevSessionClose: tagged-template values = [exchange, token, since, dayStart]; newest first, like the SQL.
    $queryRaw: jest.fn(async (_q: unknown, exchange: string, token: string, since: Date, dayStart: Date) =>
      bars.filter((b) => b.exchange === exchange && b.token === token && b.ts >= since && b.ts < dayStart).sort((a, b) => b.ts.getTime() - a.ts.getTime()),
    ),
  };
  return { repo: new DeskDayRepository(prisma as never), prisma };
}

/** Sum of the guard's today P&L over the open trades. */
const todaySum = async (repo: DeskDayRepository) => (await repo.openTrades('owner', NOW)).reduce((s, t) => s + t.todayPnl, 0);

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

  it('openTrades: today P&L of open live position trackers only', async () => {
    const open = (id: string, pnl: number, over: Partial<Row> = {}) => ({ ...closed(id, null as never, pnl), status: 'OPEN', exitTime: null, ...over });
    const { repo } = make([open('a', -300), open('b', 100), open('paper:p', -9999), open('h', -9999, { kind: 'HOLDING' })]);
    expect(await todaySum(repo)).toBe(-200);
    expect(await todaySum(make([]).repo)).toBe(0);
  });

  describe('openTrades: a position carried in from an earlier day counts only today (todayPnl)', () => {
    // NOW = 2026-11-26 13:30 IST. MAZDOCK-style PE: bought 11-24 at 44.9 x 225, prior session closed 40, now 22.5.
    const carried = (over: Partial<Row> = {}): Row => ({
      id: 'm', userId: 'owner', symbol: 'MAZDOCK29DEC261760PE', kind: 'POSITION', status: 'OPEN', entryPrice: 44.9, exitPrice: null, qty: 225,
      exitTime: null, pnl: (22.5 - 44.9) * 225, entryTime: new Date('2026-11-24T07:43:00Z'), exchange: 'NFO', token: '137759', lastLtp: 22.5, ...over,
    });
    const bar = (iso: string, close: number, over: Partial<Bar> = {}): Bar => ({ exchange: 'NFO', token: '137759', ts: new Date(iso), close, ...over });
    const prevDay = [
      bar('2026-11-25T09:59:00Z', 40), // 15:29 IST: the last in-session minute of 11-25
      bar('2026-11-25T10:05:00Z', 41), // 15:35 IST: off-session filler, ignored
      bar('2026-11-25T21:00:00Z', 40.3), // 02:30 IST on 11-26: a filler bar from TODAY (after IST midnight), never the previous close
    ];

    it('counts the move from the previous session close, not the loss since entry', async () => {
      const { repo } = make([carried()], [], null, prevDay);
      expect(await todaySum(repo)).toBeCloseTo((22.5 - 40) * 225, 6); // −3937.5, not −5040
    });

    it('a position opened today keeps its whole pnl', async () => {
      const { repo, prisma } = make([carried({ entryTime: new Date('2026-11-26T05:00:00Z') })], [], null, prevDay);
      expect(await todaySum(repo)).toBeCloseTo((22.5 - 44.9) * 225, 6);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('no stored previous close (or only off-session bars) → the full pnl, never 0', async () => {
      expect(await todaySum(make([carried()]).repo)).toBeCloseTo((22.5 - 44.9) * 225, 6);
      const offOnly = [bar('2026-11-25T10:05:00Z', 41)];
      expect(await todaySum(make([carried()], [], null, offOnly).repo)).toBeCloseTo((22.5 - 44.9) * 225, 6);
    });

    it("keeps the tracker's value factor (MCX mini: pnl is 0.1 x qty x points)", async () => {
      const goldm = carried({ symbol: 'GOLDM27NOV26126500PE', exchange: 'MCX', token: '9', entryPrice: 1158, qty: 100, lastLtp: 1639, pnl: 4810 });
      const { repo } = make([goldm], [], null, [bar('2026-11-25T17:00:00Z', 1500, { exchange: 'MCX', token: '9' })]); // 22:30 IST
      expect(await todaySum(repo)).toBeCloseTo((1639 - 1500) * 10, 6);
    });

    it('sums today-opened and carried positions; a bar from another exchange with the same token is ignored', async () => {
      const today = { ...carried({ id: 't', entryTime: new Date('2026-11-26T04:00:00Z') }), pnl: 500 };
      const { repo } = make([carried(), today], [], null, [...prevDay, bar('2026-11-25T09:58:00Z', 1, { exchange: 'BFO' })]);
      expect(await todaySum(repo)).toBeCloseTo((22.5 - 40) * 225 + 500, 6);
    });
  });

  it('openTrades carries origin (no order row = manual) and the since-entry pnl the positions block shows', async () => {
    const maz: Row = {
      id: 'maz', userId: 'owner', symbol: 'MAZDOCK29DEC261760PE', kind: 'POSITION', status: 'OPEN', entryPrice: 44.9, exitPrice: null, qty: 225,
      exitTime: null, pnl: -4399, entryTime: new Date('2026-11-25T05:00:00Z'), exchange: 'NFO', token: '137759', lastLtp: 25.35,
    };
    const m: Row = { ...maz, id: 'm', symbol: 'NIFTY02DEC2625000CE', pnl: -1200, entryTime: new Date('2026-11-26T05:00:00Z') };
    const { repo } = make([maz, m], [{ trackerId: 'm', source: 'signal' }], null, [{ exchange: 'NFO', token: '137759', ts: new Date('2026-11-25T09:59:00Z'), close: 30 }]);
    const out = await repo.openTrades('owner', NOW);
    expect(out.map((t) => [t.trackerId, t.origin, t.pnl])).toEqual([['maz', 'manual', -4399], ['m', 'signal', -1200]]);
    // carried: today's move only = (ltp − prevClose) × the tracker's pnl per point
    expect(out[0].todayPnl).toBeCloseTo((25.35 - 30) * (-4399 / (25.35 - 44.9)), 6); // ≈ −1046.3
    expect(out[1].todayPnl).toBe(-1200); // opened today: whole pnl
  });

  describe("origin: 'manual' only on positive evidence (no app order for the contract)", () => {
    const openRow = (id: string, over: Partial<Row> = {}): Row => ({
      id, userId: 'owner', symbol: 'NIFTY02DEC2625000CE', kind: 'POSITION', status: 'OPEN', entryPrice: 100, exitPrice: null, qty: 75,
      exitTime: null, pnl: -900, entryTime: new Date('2026-11-26T05:00:00Z'), exchange: 'NFO', token: '43210', lastLtp: 88, ...over,
    });
    const filled = (over: Partial<Order> = {}): Order => ({
      trackerId: null, source: 'signal', userId: 'owner', status: 'FILLED', exchange: 'NFO', token: '43210', tradingsymbol: 'NIFTY02DEC2625000CE',
      createdAt: new Date('2026-11-26T04:59:00Z'), ...over,
    });

    it('NO_TRACKER: a FILLED app order never linked to the tracker → counted with its source', async () => {
      const { repo } = make([openRow('t')], [filled({ source: 'manager' })]);
      expect((await repo.openTrades('owner', NOW))[0].origin).toBe('manager');
    });

    it('matches by tradingsymbol when the token differs', async () => {
      const { repo } = make([openRow('t')], [filled({ token: '99999', source: 'reentry' })]);
      expect((await repo.openTrades('owner', NOW))[0].origin).toBe('reentry');
    });

    it('a re-created tracker: the order is linked to an older CLOSED tracker of the same contract that closed as this one opened → counted', async () => {
      const old = { ...openRow('old'), status: 'CLOSED', exitTime: new Date('2026-11-26T05:00:30Z') };
      const { repo } = make([old, openRow('new', { entryTime: new Date('2026-11-26T05:01:00Z') })], [filled({ trackerId: 'old' })]);
      expect((await repo.openTrades('owner', NOW)).find((t) => t.trackerId === 'new')?.origin).toBe('signal');
    });

    it('a re-created tracker whose old tracker row is gone → counted', async () => {
      const { repo } = make([openRow('new')], [filled({ trackerId: 'deleted' })]);
      expect((await repo.openTrades('owner', NOW))[0].origin).toBe('signal');
    });

    it('closed today and never linked → counted too', async () => {
      const c = { ...openRow('c'), status: 'CLOSED', exitTime: new Date('2026-11-26T06:00:00Z'), exitPrice: 90, pnl: -750 };
      const { repo } = make([c], [filled()]);
      expect((await repo.closedToday('owner', NOW))[0].origin).toBe('signal');
    });

    it('still manual: no order for the contract, an order that is still the live tracker of ANOTHER open position, an old closed trade, a rejected order', async () => {
      const other = openRow('app', { symbol: 'X', token: '43210' });
      const oldClosed = { ...openRow('past'), status: 'CLOSED', exitTime: new Date('2026-11-25T08:00:00Z') };
      const { repo } = make(
        [openRow('own'), other, oldClosed],
        [filled({ trackerId: 'app' }), filled({ trackerId: 'past' }), filled({ status: 'REJECTED' }), filled({ token: '1', tradingsymbol: 'OTHER' })],
      );
      expect((await repo.openTrades('owner', NOW)).find((t) => t.trackerId === 'own')?.origin).toBe('manual');
    });
  });

  it('reset clears the pause and stamps resetAt', async () => {
    const { repo, prisma } = make([], [], { userId: 'owner', day: '2026-11-26', pausedUntil: new Date('2026-11-26T09:00:00Z'), pauseScope: 'all', resetAt: null });
    await repo.saveReset('owner', NOW);
    expect(prisma.deskGuardState.upsert.mock.calls[0][0].update).toEqual({ day: '2026-11-26', pausedUntil: null, pauseScope: null, resetAt: NOW });
  });
});
