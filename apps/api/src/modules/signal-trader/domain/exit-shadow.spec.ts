import { emptyShadow, grossPnl, shadowLine, stepShadow, type ShadowState } from './exit-shadow';

const params = { armN: 1.5, trailN: 2, givebackN: 1.5 };
const at = (min: number) => new Date(Date.UTC(2026, 9, 28, 4, min));

function run(side: 'BUY' | 'SELL', ltps: number[], o: { refSl?: number | null; n?: number | null; entry?: number } = {}) {
  let s: ShadowState = emptyShadow();
  const hits: Array<{ rule: string; price: number; min: number }> = [];
  ltps.forEach((ltp, k) => {
    const r = stepShadow(s, { side, entry: o.entry ?? 100, ltp, refSl: o.refSl ?? null, n: o.n ?? null, params, now: at(k) });
    s = r.state;
    for (const h of r.hits) hits.push({ rule: h.rule, price: h.hit.price, min: k });
  });
  return { s, hits };
}

describe('paper exit shadow', () => {
  it('STOP records the first cross only, and never again', () => {
    const r = run('BUY', [101, 95, 89, 85, 92], { refSl: 90 });
    expect(r.hits).toEqual([{ rule: 'STOP', price: 89, min: 2 }]);
  });

  it('a SELL stop is above the price', () => {
    expect(run('SELL', [99, 106, 111], { refSl: 110 }).hits).toEqual([{ rule: 'STOP', price: 111, min: 2 }]);
  });

  it('FLOOR arms after 1.5 N in favour and fires on the trail (2 N under the peak), never below breakeven', () => {
    // N = 2: arms at 103, trail = peak − 4. Peak 110 → floor 106.
    const r = run('BUY', [101, 104, 110, 107, 105.5], { n: 2 });
    expect(r.hits.find((h) => h.rule === 'FLOOR')).toEqual({ rule: 'FLOOR', price: 105.5, min: 4 });
    expect(r.s).toMatchObject({ peak: 110, floorArmed: true, floorLevel: 106 });
  });

  it('GIVEBACK needs the run first, then 1.5 N given back', () => {
    const r = run('BUY', [104, 108, 105.5, 104.9], { n: 2 });
    expect(r.hits.map((h) => h.rule)).toContain('GIVEBACK');
    // Peak 108, N 2: 105.5 gives back 2.5 (< 3), 104.9 gives back 3.1.
    expect(r.hits.find((h) => h.rule === 'GIVEBACK')).toEqual({ rule: 'GIVEBACK', price: 104.9, min: 3 });
  });

  it('no noise unit: only STOP is stepped; no LTP: nothing changes', () => {
    expect(run('BUY', [104, 110, 100], { n: null }).hits).toEqual([]);
    const s = emptyShadow();
    expect(stepShadow(s, { side: 'BUY', entry: 100, ltp: null, refSl: 90, n: 2, params, now: at(0) }).state).toBe(s);
  });

  it('a restored state keeps its latches (the floor only tightens)', () => {
    const restored: ShadowState = { peak: 110, floorArmed: true, floorLevel: 106, hits: {} };
    const r = stepShadow(restored, { side: 'BUY', entry: 100, ltp: 108, refSl: null, n: 5, params, now: at(0) });
    // N 5 would put the trail at 100; the armed level never loosens below 106.
    expect(r.state.floorLevel).toBe(106);
  });

  it('gross P&L and the line on the closed trade', () => {
    expect(grossPnl('BUY', 100, 90, 75)).toBe(-750);
    expect(grossPnl('SELL', 100, 90, 75)).toBe(750);
    const line = shadowLine({ STOP: { at: '2026-10-28T05:12:00Z', rulePnl: -1200 }, FLOOR: { at: '2026-10-28T05:35:00Z', rulePnl: 300 } }, 800);
    expect(line).toBe('stop 10:42 −₹1.2k · trail 11:05 +₹300 · held +₹800');
  });
});
