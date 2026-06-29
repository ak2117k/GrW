import { VolatilityFactor } from '../factors/volatility.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(side: 'BUY' | 'SELL'): FactorInput {
  return {
    side,
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    setupContext: {} as unknown as SetupContext,
  };
}

describe('VolatilityFactor', () => {
  let mctx: { getVixHistory: jest.Mock };

  beforeEach(() => {
    mctx = { getVixHistory: jest.fn() };
  });

  it('VIX rising 5%+ → value +1.0 (STRONG_BULL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 16.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
  });

  it('VIX rising 2-5% → value +0.5 (BULL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 15.5, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0.5);
    expect(r.tier).toBe('BULL');
  });

  it('VIX flat (within ±2%) → value 0 (NEUTRAL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 15.05, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
  });

  it('VIX falling 2-5% → value -0.5 (BEAR)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 14.55, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(-0.5);
    expect(r.tier).toBe('BEAR');
  });

  it('VIX falling 5%+ → value -1.0 (STRONG_BEAR)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 14.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('returns NEUTRAL when VIX history unavailable', async () => {
    mctx.getVixHistory.mockResolvedValue(null);
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'no VIX data' });
  });

  it('symmetric for SELL — VIX rising still positive (Mama: vol up is good for both sides)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 16.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('SELL'));
    expect(r.value).toBe(1.0);
  });
});
