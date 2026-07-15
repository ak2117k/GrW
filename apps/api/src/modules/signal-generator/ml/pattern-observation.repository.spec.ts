import { PatternObservationRepository } from './pattern-observation.repository';
import type { PatternObservationInput } from './pattern-observation.types';

function fakePrisma() {
  return {
    patternObservation: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

const input: PatternObservationInput = {
  token: '2885', exchange: 'NSE', timeframe: '15m', patternName: 'HAMMER',
  category: 'CANDLESTICK', bias: 'BULLISH', barTime: new Date(1000),
  candleWindow: [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
  atrAtDetection: 2, outcome: 'WIN', label: 1,
};

describe('PatternObservationRepository', () => {
  it('saveMany inserts with skipDuplicates and returns the count', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    const n = await repo.saveMany([input, { ...input, barTime: new Date(2000) }]);
    expect(n).toBe(2);
    expect(prisma.patternObservation.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  // Pins every field of the mapping to a distinct expected value. The same-typed
  // string columns (token/exchange/timeframe/patternName/category/bias) are all
  // mutually distinct in the fixture, so transposing any two fails this test —
  // tsc cannot catch such a swap.
  it('saveMany maps every input field to the right column, in order', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    await repo.saveMany([input, { ...input, barTime: new Date(2000) }]);
    expect(prisma.patternObservation.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [
          {
            token: '2885',
            exchange: 'NSE',
            timeframe: '15m',
            patternName: 'HAMMER',
            category: 'CANDLESTICK',
            bias: 'BULLISH',
            barTime: new Date(1000),
            candleWindow: [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
            atrAtDetection: 2,
            outcome: 'WIN',
            label: 1,
          },
          expect.objectContaining({ barTime: new Date(2000), token: '2885' }),
        ],
      }),
    );
  });

  it('saveMany with empty input does not hit the db', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    const n = await repo.saveMany([]);
    expect(n).toBe(0);
    expect(prisma.patternObservation.createMany).not.toHaveBeenCalled();
  });

  it('findPending queries oldest-first PENDING rows up to the limit', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    await repo.findPending(50);
    expect(prisma.patternObservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { outcome: 'PENDING' },
        orderBy: { barTime: 'asc' },
        take: 50,
        // `bias` is load-bearing: resolvePending labels against the direction the
        // row committed to at capture, and has no other source for it.
        select: expect.objectContaining({
          id: true, token: true, exchange: true, timeframe: true, barTime: true, bias: true,
        }),
      }),
    );
  });

  it('findPending returns the rows it read', async () => {
    const prisma = fakePrisma();
    const rows = [
      {
        id: 'a', token: '2885', exchange: 'NSE', timeframe: '15m',
        barTime: new Date(1000), bias: 'BULLISH',
      },
    ];
    prisma.patternObservation.findMany.mockResolvedValue(rows);
    const repo = new PatternObservationRepository(prisma);
    await expect(repo.findPending(10)).resolves.toEqual(rows);
  });

  it('updateOutcome writes outcome, label, resolvedAt', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    await repo.updateOutcome('id1', 'LOSS', 0);
    expect(prisma.patternObservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'id1' },
        data: expect.objectContaining({ outcome: 'LOSS', label: 0 }),
      }),
    );
  });

  it('updateOutcome stamps resolvedAt', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    await repo.updateOutcome('id1', 'TIMEOUT', null);
    const arg = prisma.patternObservation.update.mock.calls[0][0];
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    expect(arg.data.label).toBeNull();
  });
});
