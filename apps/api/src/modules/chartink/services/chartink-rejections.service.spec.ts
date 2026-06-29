// apps/api/src/modules/chartink/services/chartink-rejections.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkRejectionsService } from './chartink-rejections.service';
import { ChartinkRepository } from '../repositories/chartink.repository';

describe('ChartinkRejectionsService', () => {
  let service: ChartinkRejectionsService;
  let mockRepo: {
    findAlertSetupsInRange: jest.Mock;
    countAlertSetupsByKind: jest.Mock;
  };

  beforeEach(async () => {
    mockRepo = {
      findAlertSetupsInRange: jest.fn(),
      countAlertSetupsByKind: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkRejectionsService,
        { provide: ChartinkRepository, useValue: mockRepo },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ChartinkRejectionsService);
  });

  const sampleRows = [
    {
      id: 'r3',
      processedAt: new Date('2026-05-18T05:00:00.000Z'),
      symbol: 'INFY',
      kind: 'scored-low',
      rejectReason: 'score below threshold',
      score: 42,
      hitPrice: 1500.5,
      alert: { scanner: { scanName: 'Breakout Scan' } },
      scoreBreakdown: [
        { name: 'Sector aligned', points: 8, pointsPossible: 10, passed: true },
        { name: 'MACD on 1d', points: 6, pointsPossible: 8, passed: true },
        { name: 'MACD on 5m', points: 0, pointsPossible: 8, passed: false },
      ],
    },
    {
      id: 'r2',
      processedAt: new Date('2026-05-18T04:00:00.000Z'),
      symbol: 'TCS',
      kind: 'mtf-misaligned',
      rejectReason: null,
      score: null,
      hitPrice: 3800,
      alert: { scanner: { scanName: 'Momentum Scan' } },
    },
    {
      id: 'r1',
      processedAt: new Date('2026-05-18T03:00:00.000Z'),
      symbol: 'WIPRO',
      kind: 'no-direction',
      rejectReason: 'flat trend',
      score: 10,
      hitPrice: 250,
      alert: null,
    },
  ];

  describe('getRejections aggregation', () => {
    beforeEach(() => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue(sampleRows);
      mockRepo.countAlertSetupsByKind.mockResolvedValue([
        { kind: 'setup', _count: { _all: 5 } },
        { kind: 'scored-low', _count: { _all: 3 } },
        { kind: 'mtf-misaligned', _count: { _all: 1 } },
        { kind: 'no-direction', _count: { _all: 2 } },
      ]);
    });

    it('computes totalProcessed / accepted / rejected from grouped counts', async () => {
      const res = await service.getRejections({});
      expect(res.summary.totalProcessed).toBe(11);
      expect(res.summary.accepted).toBe(5);
      expect(res.summary.rejected).toBe(6);
    });

    it('byKind excludes setup and is sorted count desc', async () => {
      const res = await service.getRejections({});
      expect(res.summary.byKind).toEqual([
        { kind: 'scored-low', count: 3 },
        { kind: 'no-direction', count: 2 },
        { kind: 'mtf-misaligned', count: 1 },
      ]);
      expect(res.summary.byKind.some((b) => b.kind === 'setup')).toBe(false);
    });

    it('maps rejection rows to the contract shape, processedAt DESC', async () => {
      const res = await service.getRejections({});
      expect(res.rejections.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
      expect(res.rejections[0]).toEqual({
        id: 'r3',
        processedAt: '2026-05-18T05:00:00.000Z',
        symbol: 'INFY',
        scanner: 'Breakout Scan',
        kind: 'scored-low',
        reason: 'score below threshold',
        score: 42,
        hitPrice: 1500.5,
        scoreBreakdown: [
          { name: 'Sector aligned', points: 8, pointsPossible: 10, passed: true },
          { name: 'MACD on 1d', points: 6, pointsPossible: 8, passed: true },
          { name: 'MACD on 5m', points: 0, pointsPossible: 8, passed: false },
        ],
      });
    });

    it('defaults missing scanner and reason to empty string', async () => {
      const res = await service.getRejections({});
      const r1 = res.rejections.find((r) => r.id === 'r1')!;
      expect(r1.scanner).toBe('');
      expect(r1.scoreBreakdown).toBeNull();
      const r2 = res.rejections.find((r) => r.id === 'r2')!;
      expect(r2.reason).toBe('');
      expect(r2.score).toBeNull();
    });

    it('excludes setup rows from the rejections list', async () => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue([
        ...sampleRows,
        {
          id: 'accepted1',
          processedAt: new Date('2026-05-18T06:00:00.000Z'),
          symbol: 'HDFCBANK',
          kind: 'setup',
          rejectReason: null,
          score: 88,
          hitPrice: 1600,
          alert: { scanner: { scanName: 'Breakout Scan' } },
        },
      ]);
      const res = await service.getRejections({});
      expect(res.rejections.some((r) => r.kind === 'setup')).toBe(false);
      expect(res.rejections.some((r) => r.id === 'accepted1')).toBe(false);
    });

    it('maps a non-array scoreBreakdown to null (defensive — corrupted JSON)', async () => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue([
        {
          id: 'rx',
          processedAt: new Date('2026-05-18T07:00:00.000Z'),
          symbol: 'BEL',
          kind: 'error',
          rejectReason: 'indicator crash',
          score: null,
          hitPrice: 429.13,
          alert: { scanner: { scanName: 'X' } },
          scoreBreakdown: 'oops-not-an-array',
        },
      ]);
      const res = await service.getRejections({});
      expect(res.rejections[0].scoreBreakdown).toBeNull();
    });
  });

  describe('IST default date range', () => {
    beforeEach(() => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue([]);
      mockRepo.countAlertSetupsByKind.mockResolvedValue([]);
    });

    it('defaults from = IST start of today, to = now', async () => {
      const fixedNow = new Date('2026-05-18T09:15:00.000Z'); // 14:45 IST
      jest.useFakeTimers().setSystemTime(fixedNow);
      try {
        const res = await service.getRejections({});
        // IST start of 2026-05-18 = 2026-05-17T18:30:00.000Z
        expect(res.range.from).toBe('2026-05-17T18:30:00.000Z');
        expect(res.range.to).toBe('2026-05-18T09:15:00.000Z');
        const passedFrom = mockRepo.findAlertSetupsInRange.mock.calls[0][0].from;
        expect(passedFrom.toISOString()).toBe('2026-05-17T18:30:00.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('honours explicit from / to params', async () => {
      const res = await service.getRejections({
        from: '2026-05-10T00:00:00.000Z',
        to: '2026-05-12T00:00:00.000Z',
      });
      expect(res.range.from).toBe('2026-05-10T00:00:00.000Z');
      expect(res.range.to).toBe('2026-05-12T00:00:00.000Z');
    });
  });

  describe('kind filter and limit', () => {
    beforeEach(() => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue([]);
      mockRepo.countAlertSetupsByKind.mockResolvedValue([]);
    });

    it('passes the kind filter through to the repository', async () => {
      await service.getRejections({ kind: 'mtf-misaligned' });
      expect(mockRepo.findAlertSetupsInRange.mock.calls[0][0].kind).toBe('mtf-misaligned');
    });

    it('defaults limit to 200 and passes it through', async () => {
      await service.getRejections({});
      expect(mockRepo.findAlertSetupsInRange.mock.calls[0][0].limit).toBe(200);
    });

    it('passes an explicit limit through', async () => {
      await service.getRejections({ limit: 25 });
      expect(mockRepo.findAlertSetupsInRange.mock.calls[0][0].limit).toBe(25);
    });
  });
});
