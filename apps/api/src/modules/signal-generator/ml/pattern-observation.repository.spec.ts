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

  it('saveMany with empty input does not hit the db', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    const n = await repo.saveMany([]);
    expect(n).toBe(0);
    expect(prisma.patternObservation.createMany).not.toHaveBeenCalled();
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
});
