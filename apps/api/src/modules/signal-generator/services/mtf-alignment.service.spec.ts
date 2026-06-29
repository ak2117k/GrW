import { Test, type TestingModule } from '@nestjs/testing';
import { MtfAlignmentService } from './mtf-alignment.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

interface MockCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeCandles(closes: number[]): MockCandle[] {
  return closes.map((c, i) => ({
    timestamp: new Date(Date.UTC(2026, 4, 11, 9, 15 + i * 5)),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1000,
  }));
}

describe('MtfAlignmentService', () => {
  let service: MtfAlignmentService;
  let mockAdapter: { getHistoricalData: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MtfAlignmentService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(MtfAlignmentService);
    // Patch the sleep to a no-op so tests don't take seconds.
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      Promise.resolve();
  });

  it('reports aligned UP when all 4 TFs are up', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions).toEqual({
      '1d': 'UP',
      '1h': 'UP',
      '15m': 'UP',
      '5m': 'UP',
    });
  });

  it('reports aligned DOWN when all 4 TFs are down', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 99]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('DOWN');
  });

  it('aligned UP when 1d+1h agree even with 15m/5m mixed', async () => {
    // Primary-TF rule: 1d=UP + 1h=UP carries the gate regardless of the
    // shorter-TF votes. Used to be "misaligned" under the all-must-agree rule.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions['15m']).toBe('DOWN');
  });

  it('aligns UP when 1d=UP and 1h=UP even if 15m=DOWN and 5m=DOWN', async () => {
    // The morning-gap-up scenario that motivated the primary-TF rule:
    // overnight gap-up leaves 1d/1h positive, intraday pullback on the open
    // makes 5m/15m negative. The bigger trend is UP — let analyze() decide.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1d UP
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1h UP
      .mockResolvedValueOnce(makeCandles([100, 99])) // 15m DOWN
      .mockResolvedValueOnce(makeCandles([100, 99])); // 5m DOWN
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions).toEqual({
      '1d': 'UP',
      '1h': 'UP',
      '15m': 'DOWN',
      '5m': 'DOWN',
    });
  });

  it('aligns DOWN when 1d=DOWN and 1h=DOWN even if 15m=UP and 5m=UP', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 99])) // 1d DOWN
      .mockResolvedValueOnce(makeCandles([100, 99])) // 1h DOWN
      .mockResolvedValueOnce(makeCandles([100, 101])) // 15m UP
      .mockResolvedValueOnce(makeCandles([100, 101])); // 5m UP
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('DOWN');
    expect(result.directions).toEqual({
      '1d': 'DOWN',
      '1h': 'DOWN',
      '15m': 'UP',
      '5m': 'UP',
    });
  });

  it('falls back to secondary alignment when 1d=NEUTRAL but 15m+5m agree UP', async () => {
    // No Tier-A (primary) agreement because 1d/1h are NEUTRAL (sparse data).
    // Tier-B fallback: ≥2 opinions, no UP/DOWN conflict → aligned UP.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 100])) // 1d NEUTRAL
      .mockResolvedValueOnce(makeCandles([100, 100])) // 1h NEUTRAL
      .mockResolvedValueOnce(makeCandles([100, 101])) // 15m UP
      .mockResolvedValueOnce(makeCandles([100, 101])); // 5m UP
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions['1d']).toBe('NEUTRAL');
    expect(result.directions['1h']).toBe('NEUTRAL');
  });

  it('still rejects when 1d=UP but 1h=DOWN (genuine primary conflict)', async () => {
    // Primary disagreement is a real conflict; secondary fallback would
    // also see the UP+DOWN conflict, so no rescue.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1d UP
      .mockResolvedValueOnce(makeCandles([100, 99])) // 1h DOWN
      .mockResolvedValueOnce(makeCandles([100, 101])) // 15m UP
      .mockResolvedValueOnce(makeCandles([100, 99])); // 5m DOWN
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.agreedDirection).toBeNull();
  });

  it('counts equal closes as NEUTRAL (silent voter; remaining TFs decide)', async () => {
    // 1d=NEUTRAL (equal closes), 1h+15m+5m=UP. No primary agreement
    // (1d is silent), but Tier-B secondary kicks in: 3 UP opinions, no
    // conflict → aligned UP. NEUTRAL is correctly treated as silent.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 100]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats insufficient candles (<2) as NEUTRAL (silent voter)', async () => {
    // 1d has <2 candles → NEUTRAL. 1h/15m/5m all UP. Tier-B fallback
    // aligns UP because the remaining 3 TFs agree without conflict.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats broker fetch failure on any TF as NEUTRAL (silent voter)', async () => {
    // 1h fetch fails → NEUTRAL. 1d/15m/5m all UP. Primary not aligned
    // (1h silent), but Tier-B secondary aligns UP with no conflict.
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockRejectedValueOnce(new Error('Angel timeout'))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions['1h']).toBe('NEUTRAL');
  });

  it('uses the prior bar when the most-recent bar is still forming', async () => {
    const candles = makeCandles([100, 101, 95]);
    candles[candles.length - 1].timestamp = new Date(Date.now() + 60_000);
    mockAdapter.getHistoricalData.mockResolvedValue(candles);
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
  });

  it('builds rejectReason summary when misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 99]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.summary).toContain('1d=UP');
    expect(result.summary).toContain('1h=DOWN');
    expect(result.summary).toContain('15m=UP');
    expect(result.summary).toContain('5m=DOWN');
  });

  it('calls getHistoricalData with the 4 expected timeframes', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    await service.check('99926000', 'NSE');
    const calls = mockAdapter.getHistoricalData.mock.calls.map(
      (c: unknown[]) => c[2],
    );
    expect(calls).toEqual(['1d', '1h', '15m', '5m']);
  });
});
