import { MtfTrendFactor } from '../factors/mtf-trend.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(side: 'BUY' | 'SELL', bias: 'bullish' | 'bearish' | 'neutral' | null): FactorInput {
  const setupContext = bias === null
    ? ({ higherTimeframeTrend: null } as unknown as SetupContext)
    : ({
        higherTimeframeTrend: { tf: '1h', ema9: 100, ema21: 99, bias },
      } as unknown as SetupContext);
  return {
    side,
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    setupContext,
  };
}

describe('MtfTrendFactor', () => {
  const factor = new MtfTrendFactor();

  it('BUY + bullish bias → STRONG_BULL with value +1', async () => {
    const r = await factor.compute(input('BUY', 'bullish'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
    expect(r.isStub).toBe(false);
  });

  it('BUY + bearish bias → STRONG_BEAR with value -1', async () => {
    const r = await factor.compute(input('BUY', 'bearish'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('SELL + bearish bias → STRONG_BULL with value +1 (alignment-with-side)', async () => {
    const r = await factor.compute(input('SELL', 'bearish'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
  });

  it('SELL + bullish bias → STRONG_BEAR (counter)', async () => {
    const r = await factor.compute(input('SELL', 'bullish'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('neutral bias → NEUTRAL with value 0', async () => {
    const r = await factor.compute(input('BUY', 'neutral'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
  });

  it('null higherTimeframeTrend → NEUTRAL with reason', async () => {
    const r = await factor.compute(input('BUY', null));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'higher TF unavailable' });
  });
});
