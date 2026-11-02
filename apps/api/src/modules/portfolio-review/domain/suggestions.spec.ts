import { computePatterns } from './behaviour';
import { computeBreakdowns } from './metrics';
import { holdingCheck, okTrend, trade } from './review.fixtures';
import { buildSuggestions, rankSuggestions } from './suggestions';

describe('rankSuggestions', () => {
  const d = (id: string, impactRupees: number) => ({ id, category: 'RISK' as const, title: id, detail: '', evidence: '', impactRupees });
  it('ranks by rupee impact, drops non-positive and duplicate ids, numbers from 1', () => {
    const r = rankSuggestions([d('a', 100), d('b', 5000), d('c', 0), d('b', 9999), d('e', 2500)]);
    expect(r.map((s) => [s.rank, s.id])).toEqual([[1, 'b'], [2, 'e'], [3, 'a']]);
  });
  it('keeps the input order for equal impact', () => {
    expect(rankSuggestions([d('x', 10), d('y', 10)]).map((s) => s.id)).toEqual(['x', 'y']);
  });
  it('keeps at most 12', () => {
    expect(rankSuggestions(Array.from({ length: 20 }, (_, i) => d(`s${i}`, i + 1)))).toHaveLength(12);
  });
});

describe('buildSuggestions', () => {
  const nearExpiry = (net: number) => trade({ net, derivative: { type: 'CE', expiry: '2026-10-28', strike: 25000, dteAtEntry: 1, premiumPctOfStrike: 0.3 } });
  const trades = [
    nearExpiry(-4000),
    nearExpiry(-3000),
    nearExpiry(-2500),
    trade({ net: -20_000, closedBy: 'EXPIRY', underlying: 'KEI', symbol: 'KEI29SEP265800CE', returnPct: -99, derivative: { type: 'CE', expiry: '2026-09-29', strike: 5800, dteAtEntry: 43, premiumPctOfStrike: 4.7 } }),
    trade({ net: 1500, derivative: { type: 'PE', expiry: '2026-10-28', strike: 25000, dteAtEntry: 10, premiumPctOfStrike: 1 } }),
  ];
  const holdings = [
    holdingCheck({ symbol: 'IVALUE-EQ', pnl: -5160, pnlPct: -34.1, cost: 15143, tags: ['DEAD-MONEY', 'WEAK-TREND'], tag: 'DEAD-MONEY' }),
    holdingCheck({ symbol: 'IDEA-EQ', pnl: -86, pnlPct: -6.6, tags: ['WEAK-TREND'], tag: 'WEAK-TREND', trend: okTrend({ dma50: 12.6 }) }),
  ];
  const s = buildSuggestions(computeBreakdowns(trades), computePatterns(trades, trades, holdings), holdings);
  const ids = s.map((x) => x.id);

  it('fires the evidence-tied rules', () => {
    expect(ids).toEqual(expect.arrayContaining(['NEAR_EXPIRY_OPTIONS', 'FAR_OTM_OPTIONS', 'HELD_TO_EXPIRY', 'SEGMENT_OPTIONS', 'DEAD_HOLDINGS', 'WEAK_TREND_HOLDINGS', 'USE_STOPS']));
    const ne = s.find((x) => x.id === 'NEAR_EXPIRY_OPTIONS');
    expect(ne?.impactRupees).toBe(9500);
    expect(ne?.evidence).toMatch(/3 option trades entered with ≤ 2 DTE netted −₹9,500/);
  });
  it('is ranked by impact', () => {
    for (let i = 1; i < s.length; i++) expect(s[i - 1].impactRupees).toBeGreaterThanOrEqual(s[i].impactRupees);
    expect(s[0].rank).toBe(1);
  });
  it('never phrases a holding as a certain buy/sell instruction', () => {
    for (const x of s) {
      expect(`${x.title} ${x.detail}`).not.toMatch(/\b(you must|will (rise|fall|recover)|guarantee)/i);
    }
    expect(s.find((x) => x.id === 'DEAD_HOLDINGS')?.title).toMatch(/Decide/);
  });
});
