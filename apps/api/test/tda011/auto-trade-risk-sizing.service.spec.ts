import { AutoTradeRiskSizingService } from '../../src/modules/auto-execution/services/auto-trade-risk-sizing.service';
import type { PublicSignal } from '../../src/modules/signal-fanout/dto/public-signal.dto';

/**
 * TDA-011 Phase 1 — per-user risk sizing service (pure, deterministic).
 *
 * Sizing formula under test:
 *   stopLoss      = entryPrice * (1 - stopPct/100)      (BUY, long)
 *   target        = entryPrice * (1 + targetPct/100)
 *   perUnitRisk   = entryPrice - stopLoss  (= entryPrice * stopPct/100)
 *   unitsByRisk   = floor(riskPerTrade / perUnitRisk)   (₹ risked on the stop)
 *   unitsByCap    = floor(maxCapital  / entryPrice)     (₹ notional deployed)
 *   maxUnits      = min(unitsByRisk, unitsByCap)
 *   lots          = floor(maxUnits / lotSize)           (round DOWN to whole lots)
 *   quantity      = lots * lotSize
 *   lots < 1      => rejected (1 lot breaches risk or capital)
 */
function makeSignal(overrides: Partial<PublicSignal> = {}): PublicSignal {
  return {
    entryId: 'entry-1',
    symbol: 'NIFTY',
    segment: 'INTRADAY',
    side: 'BUY',
    entryPrice: 200,
    targetPct: 5,
    stopPct: 5,
    token: '99926000',
    ...overrides,
  };
}

describe('AutoTradeRiskSizingService', () => {
  let service: AutoTradeRiskSizingService;

  beforeEach(() => {
    service = new AutoTradeRiskSizingService();
  });

  it('sizes a representative INTRADAY signal from stop distance, risk-bound', () => {
    // entry 200, stop 5% -> stop 190, perUnitRisk 10.
    // risk ₹5000 / 10 = 500 units by risk; capital ₹200000 / 200 = 1000 units.
    // min = 500; lotSize 50 -> 10 lots -> qty 500.
    const signal = makeSignal({ entryPrice: 200, stopPct: 5, targetPct: 5 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 5000, maxCapital: 200000 },
      50,
    );

    expect(result).toEqual({
      lots: 10,
      quantity: 500,
      stopLoss: 190,
      target: 210,
    });
  });

  it('sizes a representative SWING signal from stop distance', () => {
    // entry 1000, stop 10% -> stop 900, perUnitRisk 100.
    // risk ₹5000 / 100 = 50 units by risk; capital ₹100000 / 1000 = 100 units.
    // min = 50; lotSize 25 -> 2 lots -> qty 50.
    const signal = makeSignal({
      segment: 'SWING',
      symbol: 'BANKNIFTY',
      entryPrice: 1000,
      stopPct: 10,
      targetPct: 10,
    });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 5000, maxCapital: 100000 },
      25,
    );

    expect(result).toEqual({
      lots: 2,
      quantity: 50,
      stopLoss: 900,
      target: 1100,
    });
  });

  it('caps deployed capital by maxCapital when capital is the binding constraint', () => {
    // entry 200, stop 5% -> perUnitRisk 10.
    // risk ₹100000 / 10 = 10000 units by risk (huge); capital ₹40000 / 200 = 200 units.
    // min = 200 (capital binds); lotSize 50 -> 4 lots -> qty 200.
    const signal = makeSignal({ entryPrice: 200, stopPct: 5 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 100000, maxCapital: 40000 },
      50,
    );

    expect(result).toMatchObject({ lots: 4, quantity: 200 });
    // notional deployed within cap
    expect((result as { quantity: number }).quantity * signal.entryPrice).toBeLessThanOrEqual(
      40000,
    );
  });

  it('rounds DOWN to whole lots (never a partial lot)', () => {
    // entry 100, stop 5% -> perUnitRisk 5. risk ₹700 / 5 = 140 units.
    // capital not binding. lotSize 50 -> floor(140/50) = 2 lots -> qty 100 (not 140).
    const signal = makeSignal({ entryPrice: 100, stopPct: 5, targetPct: 5 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 700, maxCapital: 1000000 },
      50,
    );

    expect(result).toMatchObject({ lots: 2, quantity: 100 });
  });

  it('rejects when even 1 lot breaches the per-trade risk budget', () => {
    // lotSize 50, entry 100, stop 5% -> perUnitRisk 5. 1 lot risks 50*5 = ₹250.
    // riskPerTrade ₹200 < 250 -> 0 lots -> rejected (risk-bound).
    const signal = makeSignal({ entryPrice: 100, stopPct: 5 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 200, maxCapital: 1000000 },
      50,
    );

    expect(result).toMatchObject({ rejected: true });
    expect((result as { reason: string }).reason).toMatch(/risk/i);
  });

  it('rejects when even 1 lot breaches the deployed-capital cap', () => {
    // lotSize 50, entry 100 -> 1 lot needs 50*100 = ₹5000 notional.
    // maxCapital ₹4000 < 5000 -> 0 lots -> rejected (capital-bound).
    const signal = makeSignal({ entryPrice: 100, stopPct: 5 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 1000000, maxCapital: 4000 },
      50,
    );

    expect(result).toMatchObject({ rejected: true });
    expect((result as { reason: string }).reason).toMatch(/capital/i);
  });

  it('rejects a non-positive stop distance (cannot size risk)', () => {
    const signal = makeSignal({ entryPrice: 200, stopPct: 0 });
    const result = service.sizeOrder(
      signal,
      { riskPerTrade: 5000, maxCapital: 200000 },
      50,
    );

    expect(result).toMatchObject({ rejected: true });
  });

  it('rejects non-positive per-user limits or lot size', () => {
    const signal = makeSignal();
    expect(
      service.sizeOrder(signal, { riskPerTrade: 0, maxCapital: 200000 }, 50),
    ).toMatchObject({ rejected: true });
    expect(
      service.sizeOrder(signal, { riskPerTrade: 5000, maxCapital: 0 }, 50),
    ).toMatchObject({ rejected: true });
    expect(
      service.sizeOrder(signal, { riskPerTrade: 5000, maxCapital: 200000 }, 0),
    ).toMatchObject({ rejected: true });
  });

  it('is deterministic and side-effect free (same inputs -> same output)', () => {
    const signal = makeSignal();
    const limits = { riskPerTrade: 5000, maxCapital: 200000 };
    const a = service.sizeOrder(signal, limits, 50);
    const b = service.sizeOrder(signal, limits, 50);
    expect(a).toEqual(b);
    // inputs not mutated
    expect(signal.entryPrice).toBe(200);
    expect(limits).toEqual({ riskPerTrade: 5000, maxCapital: 200000 });
  });
});
