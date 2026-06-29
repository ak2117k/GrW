import {
  computeVolumeNodes,
  computeProfileLevels,
  type ProfileCandle,
} from './volume-profile';

function c(close: number, volume: number): ProfileCandle {
  return { high: close, low: close, close, volume };
}

describe('computeVolumeNodes', () => {
  it('returns [] for fewer than 10 candles', () => {
    expect(computeVolumeNodes([c(100, 5)], 2, 100)).toEqual([]);
  });

  it('surfaces the highest-volume price bucket as a node with score', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 16; i++) candles.push(c(120 + (i % 3), 10));
    for (let i = 0; i < 8; i++) candles.push(c(150, 300));
    const nodes = computeVolumeNodes(candles, 2, 145);
    expect(nodes.length).toBeGreaterThan(0);
    expect(Math.round(nodes[0].price)).toBe(150);
    // The 150 shelf is >=3x the average bucket volume → full 40.
    expect(nodes[0].score).toBe(40);
  });

  it('caps at 5 nodes per side (<= 10 total)', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(c(100 + i, 10 + i));
    const ltp = 120;
    const nodes = computeVolumeNodes(candles, 1, ltp);
    expect(nodes.length).toBeLessThanOrEqual(10);
    expect(nodes.filter((n) => n.price > ltp).length).toBeLessThanOrEqual(5);
    expect(nodes.filter((n) => n.price < ltp).length).toBeLessThanOrEqual(5);
  });

  it('boundary: 9 candles → [], 10 candles → non-empty', () => {
    const nine = Array.from({ length: 9 }, () => c(100, 50));
    expect(computeVolumeNodes(nine, 2, 100)).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => c(100 + (i % 4), 50));
    expect(computeVolumeNodes(ten, 2, 100).length).toBeGreaterThan(0);
  });

  it('all-zero volume → nodes returned with score 0 (no div-by-zero)', () => {
    const candles = Array.from({ length: 12 }, (_, i) => c(100 + (i % 3), 0));
    const nodes = computeVolumeNodes(candles, 2, 100);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.score === 0)).toBe(true);
  });

  it('all volume above LTP → returns above-side nodes, none invented below', () => {
    const candles: ProfileCandle[] = [];
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 4; i++) candles.push(c(p, 300));
    }
    const ltp = 200;
    const nodes = computeVolumeNodes(candles, 5, ltp);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.price > ltp)).toBe(true);
  });

  it('surfaces a below-LTP node even when the top-5 volume buckets are all above LTP', () => {
    const candles: ProfileCandle[] = [];
    // Five heavy shelves ABOVE ltp (200): 210..250, volumes 500..900 — these are
    // the global top-5 by volume.
    for (const p of [210, 220, 230, 240, 250]) {
      for (let i = 0; i < 6; i++) candles.push(c(p, 500 + (p - 210) * 10));
    }
    // One lighter-but-real shelf BELOW ltp at 180 (volume 100 each) — never in
    // the global top-5, but the strongest node on the support side.
    for (let i = 0; i < 6; i++) candles.push(c(180, 100));

    const nodes = computeVolumeNodes(candles, 5, 200);

    // Global top-5 would be all-above; per-side selection must keep the 180 shelf.
    expect(nodes.some((n) => n.price < 200)).toBe(true);
    expect(nodes.some((n) => Math.round(n.price) === 180)).toBe(true);
  });

  it('distributes a wide bar volume across its high→low range, not just at the typical price', () => {
    // 12 identical wide bars: high 140, low 100, close 120 (typical = 120).
    // Old code dumped the whole bar at 120 (one bucket → both sides empty);
    // range-distribution spreads volume from 100 to 140, so support-side nodes
    // appear all the way down at the bar's low (~100), far below the typical
    // price, and the node price span is wide.
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 12; i++) candles.push({ high: 140, low: 100, close: 120, volume: 120 });
    const nodes = computeVolumeNodes(candles, 2, 120);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.price < 105)).toBe(true); // volume reached the low
    const prices = nodes.map((n) => n.price);
    expect(Math.max(...prices) - Math.min(...prices)).toBeGreaterThan(15);
  });
});

describe('computeProfileLevels', () => {
  it('returns [] for fewer than 10 candles', () => {
    expect(computeProfileLevels([c(100, 5)], 2, 100)).toEqual([]);
  });

  it('reports the highest-volume bucket as the POC (score ~40)', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 16; i++) candles.push(c(120 + (i % 3), 10));
    for (let i = 0; i < 8; i++) candles.push(c(150, 300));
    const levels = computeProfileLevels(candles, 2, 145);
    const poc = levels.find((l) => l.kind === 'POC');
    expect(poc).toBeDefined();
    expect(Math.round(poc!.price)).toBe(150);
    expect(poc!.score).toBe(40);
  });

  it('value area (VAH/VAL) spans ~70% of total volume around the POC', () => {
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const vols = [50, 60, 80, 120, 180, 300, 180, 120, 80, 60, 50];
    const candles = prices.map((p, i) => c(p, vols[i]));
    // ltp far from the data so no level is suppressed for sitting on the LTP
    // bucket; bucket size stays small (0.1) → each integer price is distinct.
    const ltp = 10;
    const levels = computeProfileLevels(candles, 1, ltp);

    const poc = levels.find((l) => l.kind === 'POC')!;
    expect(Math.round(poc.price)).toBe(105);

    const va = levels
      .filter((l) => l.kind === 'VALUE_AREA')
      .map((l) => l.price)
      .sort((a, b) => a - b);
    expect(va.length).toBe(2);
    const [val, vah] = va;
    va.forEach((_, i) => expect(levels.filter((l) => l.kind === 'VALUE_AREA')[i].score).toBe(20));

    // POC sits inside the value area, and the band is tighter than the full range.
    expect(val).toBeLessThanOrEqual(poc.price);
    expect(vah).toBeGreaterThanOrEqual(poc.price);
    expect(val).toBeGreaterThan(100);
    expect(vah).toBeLessThan(110);

    // Candles whose price falls inside [VAL, VAH] carry >= 70% of total volume.
    const total = vols.reduce((a, b) => a + b, 0);
    const inBand = prices.reduce(
      (s, p, i) => (p >= Math.round(val) && p <= Math.round(vah) ? s + vols[i] : s),
      0,
    );
    expect(inBand / total).toBeGreaterThanOrEqual(0.7);
  });

  it('skips a level that sits on the LTP bucket (POC == LTP → suppressed)', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 16; i++) candles.push(c(120 + (i % 3), 10));
    for (let i = 0; i < 8; i++) candles.push(c(150, 300));
    const levels = computeProfileLevels(candles, 2, 150);
    expect(levels.some((l) => l.kind === 'POC')).toBe(false);
  });
});
