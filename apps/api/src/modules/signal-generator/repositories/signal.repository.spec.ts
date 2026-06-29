import { SignalRepository, CreateSignalInput } from './signal.repository';

type PrismaMock = {
  signal: {
    create: jest.Mock;
    updateMany: jest.Mock;
  };
};

const buildPrismaMock = (): PrismaMock => ({
  signal: {
    create: jest.fn(async ({ data }: any) => ({ id: 'sig_test', ...data })),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
});

const baseInput: CreateSignalInput = {
  instrumentId: 'inst_1',
  side: 'BUY',
  entryPrice: 100,
  targetPrice: 110,
  stoplossPrice: 95,
  expectedProfit: 10,
  expectedLoss: 5,
  riskRewardRatio: 2,
  confidence: 'HIGH',
  confidenceScore: 80,
  strategy: 'test-strategy',
  timeframe: '15m',
  reason: 'test',
};

describe('SignalRepository.createSignal', () => {
  it('persists the expiresAt value when provided', async () => {
    const prisma = buildPrismaMock();
    const repo = new SignalRepository(prisma as any);

    const expiresAt = new Date('2026-05-11T10:00:00.000Z');
    await repo.createSignal({ ...baseInput, expiresAt });

    expect(prisma.signal.create).toHaveBeenCalledTimes(1);
    const callArg = prisma.signal.create.mock.calls[0][0];
    expect(callArg.data.expiresAt).toEqual(expiresAt);
    expect(callArg.data.isActive).toBe(true);
  });

  it('persists null expiresAt when omitted (legacy behaviour for safety)', async () => {
    const prisma = buildPrismaMock();
    const repo = new SignalRepository(prisma as any);

    await repo.createSignal(baseInput);

    const callArg = prisma.signal.create.mock.calls[0][0];
    expect(callArg.data.expiresAt).toBeNull();
  });
});

describe('SignalRepository.deactivateLegacyNullExpiry', () => {
  it('flips isActive=false on legacy rows with null expiresAt older than 24h', async () => {
    const prisma = buildPrismaMock();
    prisma.signal.updateMany.mockResolvedValueOnce({ count: 7 });
    const repo = new SignalRepository(prisma as any);

    const count = await repo.deactivateLegacyNullExpiry();

    expect(count).toBe(7);
    expect(prisma.signal.updateMany).toHaveBeenCalledTimes(1);
    const where = prisma.signal.updateMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.expiresAt).toBeNull();
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // Cutoff is "now - 24h" — should be in the recent past.
    const cutoffAgeMs = Date.now() - where.createdAt.lt.getTime();
    expect(cutoffAgeMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(cutoffAgeMs).toBeLessThan(25 * 60 * 60 * 1000);
  });
});
