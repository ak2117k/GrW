import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WatchRepository, istDayRange } from './watch.repository';

describe('WatchRepository', () => {
  let repo: WatchRepository;
  let prisma: { watchEntry: any; watchEvent: any; chartinkAlert: any; trade: any };

  beforeEach(async () => {
    prisma = {
      watchEntry: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
      watchEvent: { create: jest.fn(), findMany: jest.fn() },
      chartinkAlert: { findMany: jest.fn() },
      trade: { findMany: jest.fn() },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [WatchRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();
    repo = moduleRef.get(WatchRepository);
  });

  it('findActiveBySetupId returns existing WATCHING entry', async () => {
    prisma.watchEntry.findFirst.mockResolvedValue({ id: 'w1', status: 'WATCHING' });
    const found = await repo.findActiveBySetupId('s1');
    expect(found?.id).toBe('w1');
    expect(prisma.watchEntry.findFirst).toHaveBeenCalledWith({
      where: { setupId: 's1', status: { in: ['WATCHING', 'TRADED'] } },
    });
  });

  it('countActive returns count for WATCHING+TRADED only', async () => {
    prisma.watchEntry.count.mockResolvedValue(7);
    const n = await repo.countActive();
    expect(n).toBe(7);
    expect(prisma.watchEntry.count).toHaveBeenCalledWith({
      where: { status: { in: ['WATCHING', 'TRADED'] } },
    });
  });

  it('createEntry persists with serialized breakdown JSON', async () => {
    prisma.watchEntry.create.mockResolvedValue({ id: 'w2' });
    await repo.createEntry({
      alertId: 'a1', setupId: 's2', symbol: 'TCS-EQ', token: '11536',
      exchange: 'NSE', side: 'BUY', initialPrice: 4000, initialScore: 72,
      initialBreakdown: { foo: 1 }, profitTarget: 4150,
      profitTargetSource: 'indicator-sr', stopLossScore: 60,
    });
    expect(prisma.watchEntry.create).toHaveBeenCalled();
    const args = prisma.watchEntry.create.mock.calls[0][0];
    expect(args.data.initialBreakdown).toEqual({ foo: 1 });
    expect(args.data.status).toBeUndefined();
  });

  it('createEvent passes Prisma.JsonNull when breakdown is null', async () => {
    prisma.watchEvent.create.mockResolvedValue({ id: 'e1' });
    await repo.createEvent({ watchEntryId: 'w1', eventType: 'PRICE_CHANGE', price: 100, breakdown: null });
    const args = prisma.watchEvent.create.mock.calls[0][0];
    expect(args.data.breakdown).toBeDefined();
  });

  it('istDayRange maps an IST calendar day to the correct UTC range', () => {
    const { start, end } = istDayRange('2026-05-15');
    // IST 00:00 = UTC 18:30 on the previous day
    expect(start.toISOString()).toBe('2026-05-14T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-05-15T18:29:59.999Z');
  });

  it('list applies a createdAt range when date is given', async () => {
    prisma.watchEntry.findMany.mockResolvedValue([]);
    await repo.list({ date: '2026-05-15' });
    const args = prisma.watchEntry.findMany.mock.calls[0][0];
    expect(args.where.createdAt.gte.toISOString()).toBe('2026-05-14T18:30:00.000Z');
    expect(args.where.createdAt.lte.toISOString()).toBe('2026-05-15T18:29:59.999Z');
    expect(args.take).toBe(200);
  });

  it('findScannerNames maps alertId -> scanner.scanName', async () => {
    prisma.chartinkAlert.findMany.mockResolvedValue([
      { id: 'a1', scanner: { scanName: 'Anand Superbullish scanner May26' } },
    ]);
    const map = await repo.findScannerNames(['a1', 'a1']);
    expect(map.get('a1')).toBe('Anand Superbullish scanner May26');
    // deduped to one id
    expect(prisma.chartinkAlert.findMany.mock.calls[0][0].where.id.in).toEqual(['a1']);
  });

  it('findScannerNames returns an empty map for no ids (no query)', async () => {
    const map = await repo.findScannerNames([]);
    expect(map.size).toBe(0);
    expect(prisma.chartinkAlert.findMany).not.toHaveBeenCalled();
  });

  it('findTradeRealization maps tradeId -> { pnl, fees }, skipping null pnl', async () => {
    prisma.trade.findMany.mockResolvedValue([
      { id: 't1', pnl: 1525, fees: 117.25 },
      { id: 't2', pnl: null, fees: 0 },
      { id: 't3', pnl: -800, fees: null }, // fees null → treated as 0
    ]);
    const map = await repo.findTradeRealization(['t1', 't2', 't3']);
    expect(map.get('t1')).toEqual({ pnl: 1525, fees: 117.25 });
    expect(map.has('t2')).toBe(false); // null pnl row is skipped entirely
    // null fees coerces to 0 — the watch summary footer sums fees, so a null
    // here would propagate as NaN and corrupt the displayed total.
    expect(map.get('t3')).toEqual({ pnl: -800, fees: 0 });
  });

  it('wasTokenExecutedSince queries by token + executedAt only, NOT by status (R2 must catch closed trades)', async () => {
    prisma.watchEntry.count.mockResolvedValue(1);
    const since = new Date('2026-05-19T09:00:00Z');
    await repo.wasTokenExecutedSince('11536', since);

    const whereArg = (prisma.watchEntry.count as jest.Mock).mock.calls[0][0].where;
    expect(whereArg).toEqual({ token: '11536', executedAt: { gte: since } });
    expect(whereArg.status).toBeUndefined();
  });
});
