import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StockSectorRepository } from './stock-sector.repository';

describe('StockSectorRepository', () => {
  let repo: StockSectorRepository;
  let prisma: { stockSector: any; $transaction: jest.Mock };

  beforeEach(async () => {
    prisma = {
      stockSector: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StockSectorRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = moduleRef.get(StockSectorRepository);
  });

  it('findBySymbol returns the row keyed by uppercased symbol', async () => {
    prisma.stockSector.findUnique.mockResolvedValue({
      symbol: 'INFY',
      industry: 'Information Technology',
      sectorIndexToken: '99926013',
    });
    const row = await repo.findBySymbol('infy');
    expect(row?.sectorIndexToken).toBe('99926013');
    expect(prisma.stockSector.findUnique).toHaveBeenCalledWith({
      where: { symbol: 'INFY' },
    });
  });

  it('findBySymbol returns null when no row exists', async () => {
    prisma.stockSector.findUnique.mockResolvedValue(null);
    expect(await repo.findBySymbol('NOPE')).toBeNull();
  });

  it('upsertMany upserts every row keyed by symbol and returns the count', async () => {
    const count = await repo.upsertMany([
      { symbol: 'INFY', industry: 'Information Technology', sectorIndexToken: '99926013' },
      { symbol: 'IDEA', industry: 'Telecom - Services', sectorIndexToken: null },
    ]);
    expect(count).toBe(2);
    expect(prisma.stockSector.upsert).toHaveBeenCalledTimes(2);
    const firstCall = prisma.stockSector.upsert.mock.calls[0][0];
    expect(firstCall.where).toEqual({ symbol: 'INFY' });
    expect(firstCall.create).toMatchObject({
      symbol: 'INFY',
      industry: 'Information Technology',
      sectorIndexToken: '99926013',
    });
    expect(firstCall.update).toMatchObject({
      industry: 'Information Technology',
      sectorIndexToken: '99926013',
    });
  });

  it('upsertMany persists a null sectorIndexToken for unmapped industries', async () => {
    await repo.upsertMany([
      { symbol: 'IDEA', industry: 'Telecom - Services', sectorIndexToken: null },
    ]);
    const call = prisma.stockSector.upsert.mock.calls[0][0];
    expect(call.create.sectorIndexToken).toBeNull();
    expect(call.update.sectorIndexToken).toBeNull();
  });

  it('upsertMany returns 0 for an empty input without touching the DB', async () => {
    const count = await repo.upsertMany([]);
    expect(count).toBe(0);
    expect(prisma.stockSector.upsert).not.toHaveBeenCalled();
  });

  it('count proxies prisma.stockSector.count', async () => {
    prisma.stockSector.count.mockResolvedValue(480);
    expect(await repo.count()).toBe(480);
  });
});
