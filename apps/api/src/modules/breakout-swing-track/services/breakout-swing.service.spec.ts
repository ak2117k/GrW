import { Test } from '@nestjs/testing';
import { BreakoutSwingService, BreakoutSwingRejectError } from './breakout-swing.service';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NEAR_RES_PCT, LIMIT_PCT } from '../constants';

/**
 * Build 15m candles whose ONLY swing-pivot high (3-bar fractal) sits at
 * `resistance`. A flat baseline of `base`, with a single spike at index 10
 * exceeding its 3 neighbours on each side, makes detectSwingPivots return
 * exactly one high === resistance. n bars so candles.length ≥ 7.
 */
function candlesWithResistance(base: number, resistance: number, n = 25): any[] {
  return Array.from({ length: n }, (_, i) => {
    const high = i === 10 ? resistance : base;
    return { high, low: base - 5, close: base, timestamp: new Date() };
  });
}

/** A single completed daily bar with the given close, dated yesterday (IST). */
function dailyCandles(close: number): any[] {
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  return [{ high: close + 1, low: close - 1, close, timestamp: yesterday }];
}

describe('BreakoutSwingService.createFromAlert — entry gates', () => {
  let svc: BreakoutSwingService;
  let repo: any;
  let adapter: any;

  const baseInput = {
    alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 100, scoreBreakdown: null,
  };

  beforeEach(async () => {
    repo = {
      findActiveBySymbol: jest.fn().mockResolvedValue(null),
      createQueuedEntry: jest.fn().mockResolvedValue({ id: 'bs1' }),
    };
    adapter = {
      getLiveQuote: jest.fn(),
      getHistoricalData: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        BreakoutSwingService,
        { provide: BreakoutSwingRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(BreakoutSwingService);
  });

  it('PASS: near resistance + above prev close → QUEUED with limit = price × (1 + LIMIT_PCT)', async () => {
    // price 99.5 is 0.5% below resistance 100 (≤ NEAR_RES_PCT 1.0) and above prev close 98.
    adapter.getLiveQuote.mockResolvedValue({ ltp: 99.5 });
    adapter.getHistoricalData
      .mockResolvedValueOnce(candlesWithResistance(95, 100)) // 15m pivots → resistance 100
      .mockResolvedValueOnce(dailyCandles(98));              // prev close 98

    const res = await svc.createFromAlert(baseInput);

    expect(res).toEqual({ id: 'bs1' });
    const call = repo.createQueuedEntry.mock.calls[0][0];
    expect(call.resistance).toBe(100);
    expect(call.prevDayClose).toBe(98);
    expect(call.signalPrice).toBe(99.5);
    expect(call.limitPrice).toBeCloseTo(99.5 * (1 + LIMIT_PCT / 100), 6);
    expect(call.status).toBeUndefined(); // repo sets status QUEUED
  });

  it('REJECT: price not near resistance (> NEAR_RES_PCT below)', async () => {
    // price 90 is 10% below resistance 100 → fails Gate A.
    adapter.getLiveQuote.mockResolvedValue({ ltp: 90 });
    adapter.getHistoricalData.mockResolvedValueOnce(candlesWithResistance(85, 100));

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(BreakoutSwingRejectError);
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });

  it('REJECT: no resistance above current price', async () => {
    adapter.getLiveQuote.mockResolvedValue({ ltp: 150 });
    // Resistance pivot at 100 is BELOW price 150 → none above → reject.
    adapter.getHistoricalData.mockResolvedValueOnce(candlesWithResistance(95, 100));

    await expect(svc.createFromAlert(baseInput)).rejects.toMatchObject({ name: 'BreakoutSwingRejectError' });
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });

  it('REJECT: not above previous day close (Gate B)', async () => {
    // Near resistance passes, but price 99.5 ≤ prev close 100 → Gate B fails.
    adapter.getLiveQuote.mockResolvedValue({ ltp: 99.5 });
    adapter.getHistoricalData
      .mockResolvedValueOnce(candlesWithResistance(95, 100))
      .mockResolvedValueOnce(dailyCandles(100));

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(BreakoutSwingRejectError);
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });

  it('REJECT: live quote unavailable', async () => {
    adapter.getLiveQuote.mockResolvedValue({ ltp: 0 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(BreakoutSwingRejectError);
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });

  it('REJECT: dedup — symbol already has an active QUEUED/TRADED entry (any day; GTC resting orders persist)', async () => {
    // QUEUED orders no longer expire at EOD (they rest until filled), so the
    // dedup is all-time, not "today only" — otherwise a symbol resting from a
    // prior day would get a duplicate resting order when the scan re-fires.
    repo.findActiveBySymbol.mockResolvedValue({ id: 'existing' });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(BreakoutSwingRejectError);
    expect(adapter.getLiveQuote).not.toHaveBeenCalled();
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });

  it('Gate A boundary: exactly NEAR_RES_PCT below resistance is admitted', async () => {
    const resistance = 100;
    const price = resistance * (1 - NEAR_RES_PCT / 100); // exactly 1% below → distPct === NEAR_RES_PCT
    adapter.getLiveQuote.mockResolvedValue({ ltp: price });
    adapter.getHistoricalData
      .mockResolvedValueOnce(candlesWithResistance(90, resistance))
      .mockResolvedValueOnce(dailyCandles(price - 1));

    await expect(svc.createFromAlert(baseInput)).resolves.toEqual({ id: 'bs1' });
  });
});
