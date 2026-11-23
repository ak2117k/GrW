import {
  ReentryWatchRepository,
  familyPattern,
  filledUnits,
  isLiveLoss,
  isMissingColumn,
  liveReentryNetPnl,
  underlyingFamily,
} from './reentry-watch.repository';
import { SignalTraderRepository } from '../signal-trader/repositories/signal-trader.repository';

type RawCall = { sql: string; values: unknown[] };

/** A fake PrismaService: raw SQL is answered by the first route whose key the SQL contains. */
function fakePrisma(routes: Array<[string, unknown | ((c: RawCall) => unknown)]> = [], over: Record<string, unknown> = {}) {
  const calls: RawCall[] = [];
  const answer = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    const c = { sql, values };
    calls.push(c);
    const hit = routes.find(([k]) => sql.includes(k));
    if (!hit) return Promise.resolve([]);
    const v = typeof hit[1] === 'function' ? (hit[1] as (c: RawCall) => unknown)(c) : hit[1];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  const prisma = {
    $queryRaw: jest.fn(answer),
    $executeRaw: jest.fn(answer),
    trade: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    tradeTracker: { findMany: jest.fn().mockResolvedValue([]) },
    instrument: { findFirst: jest.fn().mockResolvedValue(null) },
    signalOrder: { create: jest.fn().mockResolvedValue({ id: 'so1' }) },
    ...over,
  };
  return { prisma, calls };
}

const DAY = new Date('2026-11-23T18:30:00Z');

describe('underlying family (same-underlying check sees minis)', () => {
  it('GOLD, GOLDM and CRUDEOIL / CRUDEOILM are one family each', () => {
    expect(underlyingFamily('GOLD')).toEqual(expect.arrayContaining(['GOLD', 'GOLDM']));
    expect(underlyingFamily('goldm')).toEqual(expect.arrayContaining(['GOLD', 'GOLDM']));
    expect(underlyingFamily('CRUDEOIL')).toEqual(expect.arrayContaining(['CRUDEOIL', 'CRUDEOILM']));
    expect(underlyingFamily('NATURALGAS')).toEqual(expect.arrayContaining(['NATGASMINI']));
    expect(underlyingFamily('SILVER')).toEqual(expect.arrayContaining(['SILVERM', 'SILVERMIC']));
    expect(underlyingFamily('NIFTY')).toEqual(['NIFTY']);
    expect(underlyingFamily('  ')).toEqual([]);
  });

  it('the pattern matches minis and never a different index', () => {
    const gold = new RegExp(familyPattern(underlyingFamily('GOLD')));
    expect(gold.test('GOLDM05DEC2678000CE')).toBe(true);
    expect(gold.test('GOLD27NOV26120000PE')).toBe(true);
    expect(gold.test('GOLDM05DEC26FUT')).toBe(true);
    const crude = new RegExp(familyPattern(underlyingFamily('CRUDEOIL')));
    expect(crude.test('CRUDEOILM17DEC265500CE')).toBe(true);
    const nifty = new RegExp(familyPattern(underlyingFamily('NIFTY')));
    expect(nifty.test('NIFTY09NOV2624400CE')).toBe(true);
    expect(nifty.test('BANKNIFTY23NOV2656900CE')).toBe(false);
    expect(nifty.test('NIFTYNXT5025NOV2670000CE')).toBe(false);
    expect(nifty.test('FINNIFTY25NOV2623000CE')).toBe(false);
  });
});

describe('§6a.5 loss of a live re-entry (own fill, tracker exit, charges)', () => {
  const o = { side: 'BUY', exchange: 'NFO', tradingsymbol: 'NIFTY09NOV2624400CE', status: 'FILLED', qty: 75, lots: 1, fillPrice: 100, fillQty: 75 };

  it('a clear winner is not a loss; a clear loser is', () => {
    expect(liveReentryNetPnl(o, 110)!).toBeGreaterThan(700);
    expect(isLiveLoss(o, 110)).toBe(false);
    expect(liveReentryNetPnl(o, 90)!).toBeLessThan(-750);
    expect(isLiveLoss(o, 90)).toBe(true);
  });

  it('a gross win smaller than the charges is a loss', () => {
    const pnl = liveReentryNetPnl(o, 100.05)!;
    expect(pnl).toBeLessThan(0);
    expect(isLiveLoss(o, 100.05)).toBe(true);
  });

  it('MCX uses the contract value factor (GOLDM ₹10 per point per 100-unit lot)', () => {
    const g = { ...o, exchange: 'MCX', tradingsymbol: 'GOLDM05DEC2678000CE', qty: 100, lots: 1, fillQty: 100, fillPrice: 500 };
    const pnl = liveReentryNetPnl(g, 510)!; // 10 pts x 100 x 0.1 = ₹100 gross
    expect(pnl).toBeGreaterThan(50);
    expect(pnl).toBeLessThan(100);
  });

  it('SELL side gains when the exit is lower', () => {
    expect(liveReentryNetPnl({ ...o, side: 'SELL' }, 90)!).toBeGreaterThan(700);
  });

  it('unreadable (no fill price, no exit, no quantity) ⇒ null ⇒ counted as a loss', () => {
    expect(liveReentryNetPnl({ ...o, fillPrice: null }, 110)).toBeNull();
    expect(liveReentryNetPnl(o, null)).toBeNull();
    expect(liveReentryNetPnl({ ...o, status: 'PARTIAL', qty: null, fillQty: null }, 110)).toBeNull();
    expect(isLiveLoss({ ...o, fillPrice: null }, 110)).toBe(true);
  });

  it('filled units: FILLED = qty; PARTIAL answered in lots is scaled to units', () => {
    expect(filledUnits({ status: 'FILLED', qty: 75, lots: 1, fillQty: 1 })).toBe(75);
    expect(filledUnits({ status: 'PARTIAL', qty: 500, lots: 5, fillQty: 2 })).toBe(200);
    expect(filledUnits({ status: 'PARTIAL', qty: 150, lots: 2, fillQty: 75 })).toBe(75);
    expect(filledUnits({ status: 'PARTIAL', qty: 150, lots: 2, fillQty: null })).toBeNull();
  });
});

describe('isMissingColumn', () => {
  it('recognises 42703 and the message', () => {
    expect(isMissingColumn({ meta: { code: '42703' } })).toBe(true);
    expect(isMissingColumn(new Error('column "source" does not exist'))).toBe(true);
    expect(isMissingColumn(new Error('connection refused'))).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});

describe('ReentryWatchRepository.liveCountsFor (DB only)', () => {
  it('per-watch = live in-flight/filled orders + paper re-entries; per-day live; losses per 6a.5', async () => {
    const { prisma, calls } = fakePrisma([
      ['reentry_watch_key =', [{ n: 2 }]],
      ['JOIN "trade_trackers"', [
        { side: 'BUY', exchange: 'NFO', tradingsymbol: 'NIFTY09NOV2624400CE', status: 'FILLED', qty: 75, lots: 1, fill_price: 100, fill_qty: 75, exit_price: 90 },
        { side: 'BUY', exchange: 'NFO', tradingsymbol: 'NIFTY09NOV2624400CE', status: 'FILLED', qty: 75, lots: 1, fill_price: 100, fill_qty: 75, exit_price: 120 },
        { side: 'BUY', exchange: 'NFO', tradingsymbol: 'NIFTY09NOV2624400CE', status: 'FILLED', qty: 75, lots: 1, fill_price: null, fill_qty: 75, exit_price: 120 },
      ]],
      ['created_at >=', [{ n: 5 }]],
    ]);
    prisma.trade.count.mockResolvedValue(1);
    const repo = new ReentryWatchRepository(prisma as never);
    const c = await repo.liveCountsFor('trade_trackers:t1', DAY);
    expect(c).toEqual({ reentriesOfWatch: 3, liveToday: 5, liveLossesToday: 2, lastLiveExitAt: null });
    const watchSql = calls.find((x) => x.sql.includes('reentry_watch_key ='))!;
    expect(watchSql.values).toEqual(expect.arrayContaining(['reentry', 'trade_trackers:t1', ['CLAIMED', 'PLACED', 'UNCERTAIN', 'FILLED', 'PARTIAL']]));
    expect(watchSql.sql).toContain('fill_qty');
    expect(prisma.trade.count).toHaveBeenCalledWith({ where: expect.objectContaining({ strategy: 'REENTRY_WATCH', entryTags: { has: 'reentry-of:trade_trackers:t1' } }) });
  });

  it('§6a.3d cooldown: returns the latest exit of this watch\'s CLOSED live re-entry trackers', async () => {
    const last = new Date('2026-11-24T05:10:00Z');
    const { prisma, calls } = fakePrisma([['MAX(t."exitTime")', [{ last_exit: last }]]]);
    const c = await new ReentryWatchRepository(prisma as never).liveCountsFor('trade_trackers:t1', DAY);
    expect(c.lastLiveExitAt).toEqual(last);
    const q = calls.find((x) => x.sql.includes('MAX(t."exitTime")'))!;
    expect(q.sql).toContain('o.tracker_id');
    expect(q.values).toEqual(expect.arrayContaining(['reentry', 'trade_trackers:t1']));
  });

  it('throws when the DB cannot be read (caller ⇒ UNKNOWN_INPUT ⇒ paper)', async () => {
    const { prisma } = fakePrisma([['reentry_watch_key =', new Error('db down')]]);
    await expect(new ReentryWatchRepository(prisma as never).liveCountsFor('k', DAY)).rejects.toThrow('db down');
  });
});

describe('ReentryWatchRepository.underlyingOpenOrInFlight', () => {
  it('false when nothing is open or in flight', async () => {
    const { prisma } = fakePrisma([['COUNT(*)', [{ n: 0 }]]]);
    expect(await new ReentryWatchRepository(prisma as never).underlyingOpenOrInFlight('GOLD', DAY)).toBe(false);
  });

  it('an open GOLDM tracker blocks GOLD (pattern + master name carry the minis)', async () => {
    const { prisma, calls } = fakePrisma([['"trade_trackers" t', [{ n: 1 }]], ['COUNT(*)', [{ n: 0 }]]]);
    expect(await new ReentryWatchRepository(prisma as never).underlyingOpenOrInFlight('GOLD', DAY)).toBe(true);
    const t = calls.find((x) => x.sql.includes('"trade_trackers" t'))!;
    const pattern = t.values.find((v) => typeof v === 'string' && v.startsWith('^')) as string;
    expect(new RegExp(pattern).test('GOLDM05DEC2678000CE')).toBe(true);
    expect(t.values).toEqual(expect.arrayContaining([expect.arrayContaining(['GOLD', 'GOLDM'])]));
  });

  it('an in-flight order (any source) or a filled one with no tracker yet blocks', async () => {
    const { prisma, calls } = fakePrisma([['"signal_orders" o', [{ n: 1 }]], ['COUNT(*)', [{ n: 0 }]]]);
    expect(await new ReentryWatchRepository(prisma as never).underlyingOpenOrInFlight('CRUDEOIL', DAY)).toBe(true);
    const o = calls.find((x) => x.sql.includes('"signal_orders" o'))!;
    expect(o.sql).toContain('tracker_id IS NULL');
    expect(o.values).toEqual(expect.arrayContaining([DAY, ['CLAIMED', 'PLACED', 'UNCERTAIN'], ['FILLED', 'PARTIAL']]));
  });

  it('an open REENTRY_WATCH paper trade blocks', async () => {
    const { prisma } = fakePrisma([['COUNT(*)', [{ n: 0 }]]]);
    prisma.trade.count.mockResolvedValue(1);
    expect(await new ReentryWatchRepository(prisma as never).underlyingOpenOrInFlight('NIFTY', DAY)).toBe(true);
  });

  it('an unreadable underlying throws (never "not open")', async () => {
    const { prisma } = fakePrisma();
    await expect(new ReentryWatchRepository(prisma as never).underlyingOpenOrInFlight('', DAY)).rejects.toThrow();
  });
});

describe('ReentryWatchRepository.exitsSince — live re-entry trackers never start a watch', () => {
  const tracker = (id: string) => ({ id, symbol: 'NIFTY09NOV2624400CE', exchange: 'NFO', qty: 75, entryTime: new Date('2026-11-23T04:00:00Z'), exitTime: new Date('2026-11-23T05:00:00Z'), exitPrice: 120 });

  it('drops trackers linked to a source=reentry order; keeps the rest unchanged', async () => {
    const { prisma, calls } = fakePrisma([['JOIN "signal_orders"', [{ id: 't2' }]]]);
    prisma.tradeTracker.findMany.mockResolvedValue([tracker('t1'), tracker('t2')]);
    prisma.instrument.findFirst.mockResolvedValue({ name: 'NIFTY' });
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(out.map((x) => x.refId)).toEqual(['t1']);
    expect(out[0]).toEqual({
      refTable: 'trade_trackers', refId: 't1', origin: 'REAL', symbol: 'NIFTY09NOV2624400CE', exchange: 'NFO', underlying: 'NIFTY',
      kind: 'CE', side: 'BUY', entryAt: tracker('t1').entryTime, exitAt: tracker('t1').exitTime, exitPrice: 120, userId: null,
    });
    const q = calls.find((x) => x.sql.includes('JOIN "signal_orders"'))!;
    expect(q.sql).toContain('tracker_id = t.id');
    expect(q.values).toEqual(expect.arrayContaining(['reentry', ['t1', 't2']]));
  });

  it('before the migration (no source column) nothing is excluded — paper reads as before', async () => {
    const { prisma } = fakePrisma([['JOIN "signal_orders"', Object.assign(new Error('column o.source does not exist'), { meta: { code: '42703' } })]]);
    prisma.tradeTracker.findMany.mockResolvedValue([tracker('t1')]);
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(out.map((x) => x.refId)).toEqual(['t1']);
  });

  it('any other read error is thrown (fail closed)', async () => {
    const { prisma } = fakePrisma([['JOIN "signal_orders"', new Error('timeout')]]);
    prisma.tradeTracker.findMany.mockResolvedValue([tracker('t1')]);
    await expect(new ReentryWatchRepository(prisma as never).exitsSince(DAY)).rejects.toThrow('timeout');
  });

  it('no real exits ⇒ no extra query', async () => {
    const { prisma } = fakePrisma();
    await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('ReentryWatchRepository.recordLiveDecision / settleLiveDecision', () => {
  it('stores the limit, detail, order id and returns the row id', async () => {
    const { prisma, calls } = fakePrisma();
    const id = await new ReentryWatchRepository(prisma as never).recordLiveDecision({
      watchKey: 'trade_trackers:t1', underlying: 'GOLD', at: DAY, direction: 'SAME', mode: 'paper', limit: 'MAX_PER_DAY', detail: '6/6',
      inputs: { a: 1 }, reasons: ['why'],
    });
    expect(typeof id).toBe('string');
    const c = calls[0];
    expect(c.sql).toContain('"limit_hit", "limit_detail", "signal_order_id"');
    expect(c.values).toEqual(expect.arrayContaining([id, 'trade_trackers:t1', 'GOLD', 'SAME', 'same-paper-max_per_day', 'paper', 'MAX_PER_DAY', '6/6', '{"a":1}', '["why"]']));
  });

  it('settle sets only the given fields', async () => {
    const { prisma, calls } = fakePrisma();
    await new ReentryWatchRepository(prisma as never).settleLiveDecision('d1', { signalOrderId: 'so1', note: 'placed' });
    expect(calls[0].sql).toContain('COALESCE');
    expect(calls[0].values).toEqual(expect.arrayContaining(['so1', '["placed"]', 'd1']));
  });
});

describe('SignalTraderRepository.claimOrder — source / reentry_watch_key', () => {
  const claim = {
    decisionId: 'd1', userId: 'u1', exchange: 'NFO', token: '123', tradingsymbol: 'NIFTY09NOV2624400CE', qty: 75, lots: 1,
    side: 'BUY', productType: 'CARRYFORWARD', limitPrice: 150, sl: 112.5, targets: [225], orderTag: 'sigabc',
  };

  it('existing callers: the same typed create as before, no new fields', async () => {
    const { prisma } = fakePrisma();
    const id = await new SignalTraderRepository(prisma as never).claimOrder(claim);
    expect(id).toBe('so1');
    expect(prisma.signalOrder.create).toHaveBeenCalledWith({ data: { ...claim, orderType: 'LIMIT', status: 'CLAIMED' }, select: { id: true } });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('a re-entry claim is one atomic INSERT carrying source + watch key; a duplicate decision ⇒ null', async () => {
    const { prisma, calls } = fakePrisma([['INSERT INTO "signal_orders"', (c: RawCall) => [{ id: c.values[0] }]]]);
    const repo = new SignalTraderRepository(prisma as never);
    const id = await repo.claimOrder({ ...claim, source: 'reentry', reentryWatchKey: 'trade_trackers:t1' });
    expect(typeof id).toBe('string');
    expect(prisma.signalOrder.create).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain('ON CONFLICT ("decision_id") DO NOTHING');
    expect(calls[0].values).toEqual(expect.arrayContaining(['d1', 'reentry', 'trade_trackers:t1', 'CARRYFORWARD', 150, '[225]']));

    const dup = fakePrisma([['INSERT INTO "signal_orders"', []]]);
    expect(await new SignalTraderRepository(dup.prisma as never).claimOrder({ ...claim, source: 'reentry', reentryWatchKey: 'k' })).toBeNull();
  });

  it('a re-entry claim with no watch key throws and writes nothing', async () => {
    const { prisma } = fakePrisma();
    await expect(new SignalTraderRepository(prisma as never).claimOrder({ ...claim, source: 'reentry' })).rejects.toThrow(/reentryWatchKey/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.signalOrder.create).not.toHaveBeenCalled();
  });
});

// ---- Review fixes (2026-11-23) ----

describe('exitsSince — carries the tracker owner (review fix 1: only the owner re-enters live)', () => {
  const tracker = (id: string, userId: string) => ({ id, userId, symbol: 'NIFTY09NOV2624400CE', exchange: 'NFO', qty: 75, entryTime: new Date('2026-11-23T04:00:00Z'), exitTime: new Date('2026-11-23T05:00:00Z'), exitPrice: 120 });

  it('reads trade_trackers.userId and puts it on every REAL exit (all users are still watched, as in paper today)', async () => {
    const { prisma } = fakePrisma();
    prisma.tradeTracker.findMany.mockResolvedValue([tracker('t1', 'owner'), tracker('t2', 'someone-else')]);
    prisma.instrument.findFirst.mockResolvedValue({ name: 'NIFTY' });
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    const q = prisma.tradeTracker.findMany.mock.calls[0][0] as { select: Record<string, unknown>; where: Record<string, unknown> };
    expect(q.select.userId).toBe(true);
    expect(q.where.userId).toBeUndefined();
    expect(out.map((x) => [x.refId, x.origin, x.userId])).toEqual([['t1', 'REAL', 'owner'], ['t2', 'REAL', 'someone-else']]);
  });

  it('a GOLDM exit is watched on GOLD (review fix 6)', async () => {
    const { prisma } = fakePrisma();
    prisma.tradeTracker.findMany.mockResolvedValue([{ ...tracker('t1', 'owner'), symbol: 'GOLDM05DEC2678000CE', exchange: 'MCX' }]);
    prisma.instrument.findFirst.mockResolvedValue({ name: 'GOLDM' });
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(out[0].underlying).toBe('GOLD');
  });

  it('a NATGASMINI exit is watched on NATURALGAS (2026-11-23: NATURALGAS joined the universe)', async () => {
    const { prisma } = fakePrisma();
    prisma.tradeTracker.findMany.mockResolvedValue([{ ...tracker('t1', 'owner'), symbol: 'NATGASMINI23DEC26330PE', exchange: 'MCX' }]);
    prisma.instrument.findFirst.mockResolvedValue({ name: 'NATGASMINI' });
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(out[0].underlying).toBe('NATURALGAS');
  });

  it('a NATGASMINI exit with no master row is still watched on NATURALGAS (name from the symbol)', async () => {
    const { prisma } = fakePrisma();
    prisma.tradeTracker.findMany.mockResolvedValue([{ ...tracker('t1', 'owner'), symbol: 'NATGASMINI23DEC26330PE', exchange: 'MCX' }]);
    const out = await new ReentryWatchRepository(prisma as never).exitsSince(DAY);
    expect(out[0].underlying).toBe('NATURALGAS');
  });
});

describe('underlyingFamily — natural gas', () => {
  it('NATURALGAS and NATGASMINI are one family (an open mini holds a NATURALGAS re-entry)', () => {
    expect(underlyingFamily('NATURALGAS')).toEqual(expect.arrayContaining(['NATURALGAS', 'NATGASMINI']));
    expect(underlyingFamily('NATGASMINI')).toEqual(expect.arrayContaining(['NATURALGAS']));
    const re = new RegExp(familyPattern(underlyingFamily('NATURALGAS')));
    expect(re.test('NATGASMINI23DEC26330PE')).toBe(true);
    expect(re.test('NATURALGAS23DEC26330CE')).toBe(true);
  });
});

describe('liveCountsFor — the NO_TRACKER fallback link (review fix 3)', () => {
  it('losses and the last live exit also match a re-entry order with no tracker_id (token + counted status + time window)', async () => {
    const { prisma, calls } = fakePrisma();
    await new ReentryWatchRepository(prisma as never).liveCountsFor('trade_trackers:t1', DAY);
    const closed = calls.find((x) => x.sql.includes('t."exitPrice" AS exit_price'))!;
    const last = calls.find((x) => x.sql.includes('MAX(t."exitTime")'))!;
    for (const q of [closed, last]) {
      expect(q.sql).toContain('o.tracker_id = t.id');
      expect(q.sql).toContain('o.tracker_id IS NULL AND o.token = t.token');
      expect(q.sql).toContain('o.user_id = t."userId"');
      expect(q.sql).toContain('o.created_at >= (t."entryTime" AT TIME ZONE \'UTC\') - interval \'15 minutes\'');
      expect(q.values).toEqual(expect.arrayContaining([['CLAIMED', 'PLACED', 'UNCERTAIN', 'FILLED', 'PARTIAL']]));
    }
    // One row per order: a fallback that matches two trackers must not count one loss twice.
    expect(closed.sql).toContain('DISTINCT ON (o.id)');
  });
});

describe('openOnUnderlying — parent and mini are one underlying (review fix 6)', () => {
  it('the paper same-underlying check sees an open GOLDM position for GOLD, and never BANKNIFTY for NIFTY', async () => {
    const { prisma, calls } = fakePrisma([['COUNT(*)', [{ n: 1 }]]]);
    await new ReentryWatchRepository(prisma as never).openOnUnderlying('GOLD');
    const pattern = calls[0].values.find((v) => typeof v === 'string' && v.startsWith('^')) as string;
    const re = new RegExp(pattern);
    expect(re.test('GOLDM05DEC2678000CE')).toBe(true);
    expect(re.test('GOLD05DEC26120000CE')).toBe(true);
    const crude = new RegExp((await (async () => {
      const f = fakePrisma([['COUNT(*)', [{ n: 0 }]]]);
      await new ReentryWatchRepository(f.prisma as never).openOnUnderlying('CRUDEOIL');
      return f.calls[0].values.find((v) => typeof v === 'string' && v.startsWith('^')) as string;
    })()));
    expect(crude.test('CRUDEOILM17DEC265500CE')).toBe(true);
    const f2 = fakePrisma([['COUNT(*)', [{ n: 0 }]]]);
    await new ReentryWatchRepository(f2.prisma as never).openOnUnderlying('NIFTY');
    const nifty = new RegExp(f2.calls[0].values.find((v) => typeof v === 'string' && v.startsWith('^')) as string);
    expect(nifty.test('NIFTY09NOV2624400CE')).toBe(true);
    expect(nifty.test('BANKNIFTY23NOV2656900CE')).toBe(false);
    // the REENTRY_WATCH paper trades on the mini count too
    expect(JSON.stringify(prisma.trade.count.mock.calls[0][0])).toContain('GOLDM');
  });
});

describe('pendingLiveReentryOrders — restart recovery of live re-entry orders (review fix 5)', () => {
  it("reads today's source='reentry' PLACED / UNCERTAIN rows; an UNCERTAIN row with no broker id is followed by its tag", async () => {
    const row = { id: 'so1', broker_order_id: null, order_tag: 'sigabc', user_id: 'owner', exchange: 'NFO', token: '1', tradingsymbol: 'NIFTY09NOV2624400CE', side: 'BUY', qty: 75, lots: 1, limit_price: 100, sl: 75, targets: [150], status: 'UNCERTAIN' };
    const { prisma, calls } = fakePrisma([['FROM "signal_orders"', [row, { ...row, id: 'so2', broker_order_id: 'B2', status: 'PLACED' }]]]);
    const rows = await new ReentryWatchRepository(prisma as never).pendingLiveReentryOrders(DAY, ['PLACED', 'UNCERTAIN']);
    expect(calls[0].values).toEqual(expect.arrayContaining(['reentry', DAY, ['PLACED', 'UNCERTAIN']]));
    expect(rows).toEqual([
      { id: 'so1', brokerOrderId: 'tag:sigabc', orderTag: 'sigabc', userId: 'owner', exchange: 'NFO', token: '1', tradingsymbol: 'NIFTY09NOV2624400CE', side: 'BUY', qty: 75, lots: 1, limitPrice: 100, sl: 75, targets: [150] },
      { id: 'so2', brokerOrderId: 'B2', orderTag: 'sigabc', userId: 'owner', exchange: 'NFO', token: '1', tradingsymbol: 'NIFTY09NOV2624400CE', side: 'BUY', qty: 75, lots: 1, limitPrice: 100, sl: 75, targets: [150] },
    ]);
  });

  it('before the migration (no source column) there are no live re-entry orders', async () => {
    const { prisma } = fakePrisma([['FROM "signal_orders"', Object.assign(new Error('column "source" does not exist'), { meta: { code: '42703' } })]]);
    expect(await new ReentryWatchRepository(prisma as never).pendingLiveReentryOrders(DAY, ['PLACED'])).toEqual([]);
  });
});
