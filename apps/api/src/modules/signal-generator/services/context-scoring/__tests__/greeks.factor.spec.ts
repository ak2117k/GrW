import { GreeksFactor } from '../factors/greeks.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(
  side: 'BUY' | 'SELL',
  delta: number | null,
): FactorInput {
  const recommendedStrike = delta === null
    ? null
    : {
        strike: 24000,
        side: side === 'BUY' ? 'CE' : 'PE',
        expiry: '2026-05-29',
        ltp: 100,
        delta,
        gamma: 0.01,
        theta: -10,
        vega: 50,
        iv: 15,
        oi: 1000,
        volume: 100,
        expectedProfitPerShare: 50,
        expectedLossPerShare: -50,
        lotSize: 75,
        expectedProfitPerLot: 3750,
        expectedLossPerLot: -3750,
        reason: 'test',
      };
  const setupContext = {
    recommendedStrike,
  } as unknown as SetupContext;
  return { side, token: '99926000', symbol: 'NIFTY', exchange: 'NSE', setupContext };
}

describe('GreeksFactor', () => {
  const factor = new GreeksFactor();

  it('BUY + positive delta → supportive value scaled by magnitude', async () => {
    const r = await factor.compute(input('BUY', 0.6));
    expect(r.value).toBe(1.0); // 0.6 / 0.6 = 1.0
    expect(r.tier).toBe('STRONG_BULL');
    expect(r.isStub).toBe(false);
  });

  it('BUY + negative delta → counter-aligned (negative value)', async () => {
    const r = await factor.compute(input('BUY', -0.4));
    expect(r.value).toBeCloseTo(-0.667, 2); // -0.4 / 0.6 = -0.667
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('SELL + negative delta (PE) → supportive value', async () => {
    const r = await factor.compute(input('SELL', -0.3));
    expect(r.value).toBeCloseTo(0.5, 2);
    expect(r.tier).toBe('BULL');
  });

  it('SELL + positive delta (CE) → counter', async () => {
    const r = await factor.compute(input('SELL', 0.5));
    expect(r.value).toBeCloseTo(-0.833, 2);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('null recommendedStrike → NEUTRAL with reason', async () => {
    const r = await factor.compute(input('BUY', null));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'no strike recommendation' });
  });

  it('|delta| > 0.6 still clamps value to ±1.0', async () => {
    const r = await factor.compute(input('BUY', 0.95));
    expect(r.value).toBe(1.0);
  });
});
