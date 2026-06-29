import { resolveStop, resolveTrail, sizeQuantity } from './adaptive-stop-math';

describe('resolveStop', () => {
  it('uses ATR_MULT × atr5m when within bounds', () => {
    const r = resolveStop(1000, 10); // 1.2×10=12 (1.2%) — within [0.8%,2.5%]
    expect(r.stopPrice).toBeCloseTo(988, 6);
    expect(r.stopPct).toBeCloseTo(1.2, 6);
    expect(r.basis).toBe('atr');
  });
  it('floors at MIN_STOP_PCT when ATR is tiny', () => {
    const r = resolveStop(1000, 1); // 1.2×1=1.2 → 0.12% < 0.8%
    expect(r.stopPct).toBeCloseTo(0.8, 6);
    expect(r.stopPrice).toBeCloseTo(992, 6);
    expect(r.basis).toBe('floor');
  });
  it('caps at MAX_STOP_PCT when ATR is huge', () => {
    const r = resolveStop(1000, 50); // 1.2×50=60 → 6% > 2.5%
    expect(r.stopPct).toBeCloseTo(2.5, 6);
    expect(r.stopPrice).toBeCloseTo(975, 6);
    expect(r.basis).toBe('cap');
  });
  it('falls back to floor when atr5m is missing/<=0', () => {
    expect(resolveStop(1000, 0).basis).toBe('floor');
    expect(resolveStop(1000, NaN).stopPct).toBeCloseTo(0.8, 6);
  });
});

describe('resolveTrail', () => {
  it('uses TRAIL_ATR_MULT × atr5m when within bounds (wider than the old flat 0.5%)', () => {
    const r = resolveTrail(2000, 20); // 1.0×20=20 (1.0%) — within [0.6%,1.5%]
    expect(r.trailPct).toBeCloseTo(1.0, 6);
    expect(r.stopPrice).toBeCloseTo(1980, 6); // 2000 - 20; old flat 0.5% would be 1990
    expect(r.basis).toBe('atr');
  });
  it('floors at TRAIL_MIN_PCT when ATR is tiny', () => {
    const r = resolveTrail(2000, 2); // 1.0×2=2 → 0.1% < 0.6%
    expect(r.trailPct).toBeCloseTo(0.6, 6);
    expect(r.stopPrice).toBeCloseTo(1988, 6); // 2000 - 0.6%
    expect(r.basis).toBe('floor');
  });
  it('caps at TRAIL_MAX_PCT when ATR is huge', () => {
    const r = resolveTrail(2000, 80); // 1.0×80=80 → 4% > 1.5%
    expect(r.trailPct).toBeCloseTo(1.5, 6);
    expect(r.stopPrice).toBeCloseTo(1970, 6); // 2000 - 1.5%
    expect(r.basis).toBe('cap');
  });
  it('falls back to floor when atr5m is missing/<=0', () => {
    expect(resolveTrail(2000, 0).basis).toBe('floor');
    expect(resolveTrail(2000, NaN).trailPct).toBeCloseTo(0.6, 6);
  });
  it('places the stop ABOVE high-water for SELL (side=-1)', () => {
    const r = resolveTrail(2000, 20, -1);
    expect(r.stopPrice).toBeCloseTo(2020, 6);
  });
});

describe('sizeQuantity', () => {
  it('risk-first: qty = floor(RISK_PER_TRADE / stopDist)', () => {
    expect(sizeQuantity(12)).toBe(66); // floor(800/12)=66
  });
  it('returns 0 when one share exceeds the risk budget (stopDist > RISK)', () => {
    expect(sizeQuantity(900)).toBe(0);
  });
});
