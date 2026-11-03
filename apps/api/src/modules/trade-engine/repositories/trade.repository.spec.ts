import { Test, TestingModule } from '@nestjs/testing';
import { TradeRepository, pickInstrumentRow } from './trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Spec for the optional `source` filter on getOpenTrades (Task 4).
 *
 * GET /api/trades/open?source=MANUAL scopes the manual-trade page to
 * user-placed orders only. With no source the where-clause must be
 * unchanged so existing consumers (kill-switch, positions sync) still see
 * every open trade.
 */
describe('TradeRepository.getOpenTrades — source filter', () => {
  let module: TestingModule;
  let repo: TradeRepository;
  let findMany: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn(async () => []);

    module = await Test.createTestingModule({
      providers: [
        TradeRepository,
        {
          provide: PrismaService,
          useValue: { trade: { findMany } },
        },
      ],
    }).compile();

    repo = module.get(TradeRepository);
  });

  it('adds a source filter to the where clause when source is provided', async () => {
    await repo.getOpenTrades('MANUAL');

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      source: 'MANUAL',
    });
  });

  it('omits the source filter when no source is passed (unchanged behavior)', async () => {
    await repo.getOpenTrades();

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
    });
    expect(arg.where).not.toHaveProperty('source');
  });
});

describe('TradeRepository.findInstrumentId — token reuse after expiry (prod 2026-11-03)', () => {
  const now = new Date('2026-11-03T05:00:00Z');
  const godrej = { id: 'old', symbol: 'GODREJCP25AUG26940CE', token: '95394', expiry: new Date('2026-08-25T00:00:00+05:30'), updatedAt: new Date('2026-08-01') };
  const cdsl = { id: 'new', symbol: 'CDSL23NOV261260CE', token: '95394', expiry: new Date('2026-11-23T00:00:00+05:30'), updatedAt: new Date('2026-11-03') };

  it('the exact tradingsymbol wins over an older contract that shares the token', () => {
    expect(pickInstrumentRow([godrej, cdsl], 'CDSL23NOV261260CE', '95394', now)?.id).toBe('new');
  });

  it('only the expired contract shares the token → null (the caller upserts the right row), never the wrong contract', () => {
    expect(pickInstrumentRow([godrej], 'CDSL23NOV261260CE', '95394', now)).toBeNull();
  });

  it('token-only callers (symbol = token, equity spelled differently) get the live row, newest expiry first', () => {
    const later = { ...cdsl, id: 'later', symbol: 'X', expiry: new Date('2026-12-28T00:00:00+05:30') };
    expect(pickInstrumentRow([godrej, cdsl, later], '95394', '95394', now)?.id).toBe('later');
    const eq = { id: 'eq', symbol: 'TCS-EQ', token: '11536', expiry: null };
    expect(pickInstrumentRow([eq], 'TCS', '11536', now)?.id).toBe('eq');
    // Expiry day itself is still live (IST day, not the UTC instant).
    const today = { ...cdsl, id: 'today', expiry: new Date('2026-11-03T00:00:00+05:30') };
    expect(pickInstrumentRow([today], '95394', '95394', now)?.id).toBe('today');
  });

  it('queries both matches on the exchange and picks in code (no arbitrary findFirst)', async () => {
    const findMany = jest.fn(async () => [godrej, cdsl]);
    const repo = new TradeRepository({ instrument: { findMany } } as any);
    await expect(repo.findInstrumentId('CDSL23NOV261260CE', 'NFO', '95394', now)).resolves.toBe('new');
    expect((findMany.mock.calls[0] as any[])[0].where).toEqual({ exchange: 'NFO', OR: [{ symbol: 'CDSL23NOV261260CE' }, { token: '95394' }] });
  });
});

describe('TradeRepository.markOpenTrade — a stale mark never overwrites a close (BSE23NOV263600CE 2026-11-03)', () => {
  it('writes only while the trade is OPEN, in one conditional statement', async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const repo = new TradeRepository({ trade: { updateMany } } as any);
    await expect(repo.markOpenTrade('t1', { pnl: -363.34, pnlPercent: -1.03 })).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 't1', status: 'OPEN' }, data: { pnl: -363.34, pnlPercent: -1.03 } });
    updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(repo.markOpenTrade('t1', { pnl: 1, pnlPercent: 0.1 })).resolves.toBe(true);
  });
});
