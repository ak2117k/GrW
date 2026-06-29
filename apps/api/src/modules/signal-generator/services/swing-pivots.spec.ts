import {
  detectSwingPivots,
  detectWeightedPivots,
  type PivotCandle,
} from './swing-pivots';

const mk = (h: number, l: number): PivotCandle => ({ high: h, low: l });
const mkv = (
  h: number,
  l: number,
  o: number,
  c: number,
  v: number,
): PivotCandle => ({ high: h, low: l, open: o, close: c, volume: v });

describe('detectSwingPivots', () => {
  it('detects an obvious swing high and swing low with correct kind and price', () => {
    // Flat baseline, with a clear swing HIGH spike at index 7 and a clear
    // swing LOW dip at index 14. Both have 3+ bars of context on each side.
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 22; i++) {
      candles.push(mk(100, 99));
    }
    candles[7] = mk(110, 99); // swing high spike
    candles[14] = mk(100, 90); // swing low dip

    const pivots = detectSwingPivots(candles);

    const high = pivots.find((p) => p.kind === 'high');
    const low = pivots.find((p) => p.kind === 'low');

    expect(high).toBeTruthy();
    expect(high!.price).toBe(110);
    expect(low).toBeTruthy();
    expect(low!.price).toBe(90);
  });

  it('skips the first and last 3 bars (unconfirmed edges)', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 10; i++) candles.push(mk(100, 99));
    candles[1] = mk(120, 99); // too close to the start — cannot confirm
    candles[9] = mk(120, 99); // last bar — cannot confirm
    const pivots = detectSwingPivots(candles);
    expect(pivots).toEqual([]);
  });
});

describe('detectWeightedPivots', () => {
  it('returns HISTORY pivots scored within the 0..25 range', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 22; i++) candles.push(mk(100, 99));
    candles[7] = mk(110, 99);

    const pivots = detectWeightedPivots(candles);
    expect(pivots.length).toBeGreaterThan(0);
    for (const p of pivots) {
      expect(p.kind).toBe('HISTORY');
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(25);
    }
  });

  it('returns [] when there are not enough bars to confirm a pivot', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 6; i++) candles.push(mk(100, 99)); // < 2*strength+1
    expect(detectWeightedPivots(candles)).toEqual([]);
  });

  it('respects a wider configurable fractal strength', () => {
    // A spike at index 4 clears its ±3 neighbours but NOT its ±5 neighbours,
    // because a TALLER bar sits 5 positions away.
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 24; i++) candles.push(mk(100, 99));
    candles[7] = mk(108, 99); // local peak vs ±3 only
    candles[12] = mk(115, 99); // taller bar 5 bars to the right (within ±5)

    const atThree = detectWeightedPivots(candles, { strength: 3 });
    const atFive = detectWeightedPivots(candles, { strength: 5 });

    // strength=3 confirms the 108 peak (its ±3 neighbours are all 100)
    expect(atThree.some((p) => Math.abs(p.price - 108) < 0.01)).toBe(true);
    // strength=5 cannot confirm 108 — the 115 bar is within ±5
    expect(atFive.some((p) => Math.abs(p.price - 108) < 0.01)).toBe(false);
  });

  it('scores a multiply-retested level higher than a once-touched one', () => {
    // Level A (~120): pivot then revisited several times and rejected.
    // Level B (~140): pivot touched once, never retested.
    const candles: PivotCandle[] = [];
    const base = () => mk(100, 99);
    for (let i = 0; i < 60; i++) candles.push(base());

    // Pivot A high at index 7
    candles[7] = mk(120, 110);
    // retests of A: bars that poke back up near 120 then fall away
    candles[14] = mk(120, 112);
    candles[20] = mk(120, 111);
    candles[26] = mk(120, 113);

    // Pivot B high at index 40, never retested afterwards
    candles[40] = mk(140, 130);

    const pivots = detectWeightedPivots(candles, { strength: 3 });
    const a = pivots.find((p) => Math.abs(p.price - 120) < 0.5);
    const b = pivots.find((p) => Math.abs(p.price - 140) < 0.5);

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  it('scores a sharp-rejection / high-volume pivot higher than a weak one', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 30; i++) candles.push(mkv(100, 99, 99.5, 99.8, 1000));

    // Strong pivot: long upper wick (sharp rejection) + heavy volume.
    candles[7] = mkv(120, 100, 101, 101.5, 5000); // wick = 120-101.5 = 18.5 of 20 range
    // Weak pivot: small wick (body near the high) + average volume.
    candles[20] = mkv(112, 100, 100.5, 111.5, 1000); // wick = 112-111.5 = 0.5 of 12 range

    const pivots = detectWeightedPivots(candles, { strength: 3 });
    const strong = pivots.find((p) => Math.abs(p.price - 120) < 0.5);
    const weak = pivots.find((p) => Math.abs(p.price - 112) < 0.5);

    expect(strong).toBeTruthy();
    expect(weak).toBeTruthy();
    expect(strong!.score).toBeGreaterThan(weak!.score);
  });

  it('merges near-duplicate pivots, keeping the strongest', () => {
    const candles: PivotCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(mk(100, 99));

    // Two highs at virtually the same level (within default merge tolerance).
    // The first is retested (stronger), the second is a lone touch.
    candles[7] = mk(150, 140);
    candles[14] = mk(150, 141); // retest of ~150 -> boosts pivot at 7
    candles[21] = mk(150.2, 142); // near-duplicate level, lone

    const pivots = detectWeightedPivots(candles, { strength: 3 });
    const near150 = pivots.filter((p) => Math.abs(p.price - 150) < 1);

    // collapsed into a single merged pivot
    expect(near150.length).toBe(1);
  });
});
