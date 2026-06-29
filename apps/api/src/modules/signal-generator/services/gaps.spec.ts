import { gapLevels, type GapCandle } from './gaps';

function g(high: number, low: number): GapCandle {
  return { high, low };
}

describe('gapLevels', () => {
  it('returns [] for fewer than 2 candles', () => {
    expect(gapLevels([], 100)).toEqual([]);
    expect(gapLevels([g(100, 95)], 100)).toEqual([]);
  });

  it('finds an unfilled gap-up and emits the prior-high edge', () => {
    const candles: GapCandle[] = [
      g(100, 95),
      g(110, 105), // gap up: low 105 > prior high 100 → edge 100
      g(115, 108), // stays above 100 → unfilled
      g(118, 109),
    ];
    const levels = gapLevels(candles, 115);
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBe(100);
    expect(levels[0].kind).toBe('GAP');
    expect(levels[0].score).toBeGreaterThan(0);
    expect(levels[0].score).toBeLessThanOrEqual(20);
  });

  it('finds an unfilled gap-down and emits the prior-low edge', () => {
    const candles: GapCandle[] = [
      g(120, 115),
      g(110, 105), // gap down: high 110 < prior low 115 → edge 115
      g(108, 103), // stays below 115 → unfilled
      g(106, 101),
    ];
    const levels = gapLevels(candles, 105);
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBe(115);
    expect(levels[0].kind).toBe('GAP');
  });

  it('ignores a gap that has since been filled', () => {
    const candles: GapCandle[] = [
      g(100, 95),
      g(110, 105), // gap up edge 100
      g(104, 98), // low 98 <= 100 → gap filled
      g(106, 100),
    ];
    const levels = gapLevels(candles, 105);
    expect(levels.some((l) => l.price === 100)).toBe(false);
  });

  it('caps to the 3 most-recent unfilled gaps', () => {
    // Staircase of gap-ups, each edge unfilled (price only rises).
    const candles: GapCandle[] = [g(10, 5)];
    let base = 20;
    for (let i = 0; i < 6; i++) {
      candles.push(g(base + 5, base)); // low = base > prior high
      base += 20;
    }
    const levels = gapLevels(candles, base + 100);
    expect(levels.length).toBeLessThanOrEqual(3);
    expect(levels.every((l) => l.kind === 'GAP')).toBe(true);
  });

  it('skips a gap edge sitting on the live price', () => {
    const candles: GapCandle[] = [
      g(100, 95),
      g(110, 105), // edge 100
      g(115, 108),
    ];
    const levels = gapLevels(candles, 100); // ltp == edge
    expect(levels.some((l) => l.price === 100)).toBe(false);
  });
});
