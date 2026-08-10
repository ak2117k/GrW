import {
  ZoneBreakObservationRepository,
  type ZoneBreakCaptureInput,
} from './zone-break-observation.repository';

function fakePrisma() {
  return {
    zoneBreakObservation: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

const input: ZoneBreakCaptureInput = {
  token: '2885',
  exchange: 'NSE',
  timeframe: '15m',
  side: 'UP',
  barTime: new Date(1000),
  zoneClassification: 'STRONG',
  touchCount: 4,
  volumeBucket: 'HIGH',
  htfAgreed: true,
  atrAtDetection: 2,
  targetDistAtr: 3,
  stopDistAtr: 1.25,
  targetSource: 'ZONE',
};

const group = (outcome: string, n: number) => ({ outcome, _count: { _all: n } });

describe('ZoneBreakObservationRepository', () => {
  describe('saveMany', () => {
    it('inserts with skipDuplicates and returns the count', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      const n = await repo.saveMany([input, { ...input, barTime: new Date(2000) }]);
      expect(n).toBe(2);
      expect(prisma.zoneBreakObservation.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    // Pins every field of the mapping to a distinct expected value. The
    // same-typed columns (token/exchange/timeframe/side/zoneClassification/
    // volumeBucket/targetSource, and the three numeric ATR distances) are all
    // mutually distinct in the fixture, so transposing any two fails this test —
    // tsc cannot catch such a swap.
    it('maps every input field to the right column', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.saveMany([input]);
      expect(prisma.zoneBreakObservation.createMany).toHaveBeenCalledWith({
        skipDuplicates: true,
        data: [
          {
            token: '2885',
            exchange: 'NSE',
            timeframe: '15m',
            side: 'UP',
            barTime: new Date(1000),
            zoneClassification: 'STRONG',
            touchCount: 4,
            volumeBucket: 'HIGH',
            htfAgreed: true,
            atrAtDetection: 2,
            targetDistAtr: 3,
            stopDistAtr: 1.25,
            targetSource: 'ZONE',
            outcome: 'PENDING',
            label: null,
          },
        ],
      });
    });

    // Capture is LIVE-EDGE only: the row is born PENDING and only the resolver
    // may assign an outcome. A caller cannot smuggle a pre-judged label in.
    it('always writes PENDING with a null label, whatever the caller passes', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.saveMany([{ ...input, outcome: 'WIN', label: 1 } as any]);
      const row = prisma.zoneBreakObservation.createMany.mock.calls[0][0].data[0];
      expect(row.outcome).toBe('PENDING');
      expect(row.label).toBeNull();
    });

    it('empty input does not hit the db', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await expect(repo.saveMany([])).resolves.toBe(0);
      expect(prisma.zoneBreakObservation.createMany).not.toHaveBeenCalled();
    });
  });

  describe('findPending', () => {
    it('queries oldest-first PENDING rows up to the limit', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.findPending(50);
      expect(prisma.zoneBreakObservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { outcome: 'PENDING' },
          orderBy: { barTime: 'asc' },
          take: 50,
        }),
      );
    });

    // All three ATR numbers are load-bearing: the resolver labels each row with
    // ITS OWN k/m, and has no other source for them. Dropping any one would push
    // resolution back onto a shared constant — the exact overloading this table
    // exists to avoid.
    it('selects the row geometry the resolver labels against', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.findPending(10);
      const select = prisma.zoneBreakObservation.findMany.mock.calls[0][0].select;
      expect(select).toEqual(
        expect.objectContaining({
          id: true, token: true, exchange: true, timeframe: true, side: true, barTime: true,
          atrAtDetection: true, targetDistAtr: true, stopDistAtr: true,
        }),
      );
    });

    it('returns the rows it read', async () => {
      const prisma = fakePrisma();
      const rows = [
        {
          id: 'a', token: '2885', exchange: 'NSE', timeframe: '15m', side: 'UP',
          barTime: new Date(1000), atrAtDetection: 2, targetDistAtr: 3, stopDistAtr: 1,
        },
      ];
      prisma.zoneBreakObservation.findMany.mockResolvedValue(rows);
      const repo = new ZoneBreakObservationRepository(prisma);
      await expect(repo.findPending(10)).resolves.toEqual(rows);
    });
  });

  describe('updateOutcome', () => {
    it('writes outcome, label and stamps resolvedAt', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.updateOutcome('id1', 'LOSS', 0);
      const arg = prisma.zoneBreakObservation.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'id1' });
      expect(arg.data.outcome).toBe('LOSS');
      expect(arg.data.label).toBe(0);
      expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    });

    it('a TIMEOUT carries a null label', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.updateOutcome('id1', 'TIMEOUT', null);
      expect(prisma.zoneBreakObservation.update.mock.calls[0][0].data.label).toBeNull();
    });
  });

  describe('statsForSymbol', () => {
    it('groups by outcome over the symbol/timeframe index', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.statsForSymbol('2885', 'NSE', '15m');
      expect(prisma.zoneBreakObservation.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['outcome'],
          where: expect.objectContaining({ token: '2885', exchange: 'NSE', timeframe: '15m' }),
        }),
      );
    });

    // PENDING breaks are not evidence — nobody has seen how they ended. Counting
    // them would dilute every percentage toward zero as the live edge grows.
    it('counts only RESOLVED outcomes', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.statsForSymbol('2885', 'NSE', '15m');
      const where = prisma.zoneBreakObservation.groupBy.mock.calls[0][0].where;
      expect(where.outcome).toEqual({ in: ['WIN', 'LOSS', 'TIMEOUT'] });
    });

    it('tallies wins and the full resolved sample', async () => {
      const prisma = fakePrisma();
      prisma.zoneBreakObservation.groupBy.mockResolvedValue([
        group('WIN', 12), group('LOSS', 7), group('TIMEOUT', 3),
      ]);
      const repo = new ZoneBreakObservationRepository(prisma);
      // A TIMEOUT is a resolved non-win: it belongs in the denominator, not the
      // numerator, or the hit-rate would silently exclude breaks that went nowhere.
      await expect(repo.statsForSymbol('2885', 'NSE', '15m')).resolves.toEqual({
        wins: 12,
        sample: 22,
      });
    });

    it('an untouched symbol tallies to zero, not to a fabricated number', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await expect(repo.statsForSymbol('9999', 'NSE', '1h')).resolves.toEqual({
        wins: 0,
        sample: 0,
      });
    });
  });

  describe('statsForCohort', () => {
    it('filters on all four cohort fields', async () => {
      const prisma = fakePrisma();
      const repo = new ZoneBreakObservationRepository(prisma);
      await repo.statsForCohort({
        timeframe: '15m',
        zoneClassification: 'STRONG',
        volumeBucket: 'HIGH',
        htfAgreed: false,
      });
      const where = prisma.zoneBreakObservation.groupBy.mock.calls[0][0].where;
      expect(where).toEqual({
        timeframe: '15m',
        zoneClassification: 'STRONG',
        volumeBucket: 'HIGH',
        htfAgreed: false,
        outcome: { in: ['WIN', 'LOSS', 'TIMEOUT'] },
      });
    });

    it('tallies the cohort the same way', async () => {
      const prisma = fakePrisma();
      prisma.zoneBreakObservation.groupBy.mockResolvedValue([group('WIN', 40), group('LOSS', 60)]);
      const repo = new ZoneBreakObservationRepository(prisma);
      await expect(
        repo.statsForCohort({
          timeframe: '1h', zoneClassification: 'MEDIUM', volumeBucket: 'UNKNOWN', htfAgreed: true,
        }),
      ).resolves.toEqual({ wins: 40, sample: 100 });
    });
  });
});
