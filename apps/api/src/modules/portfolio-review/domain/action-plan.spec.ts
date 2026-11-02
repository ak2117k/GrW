import { PLAN_DISCLAIMER, PLAN_RULES, actionPlanDigest, buildActionPlan, classifyHolding, entryZone, ideaScore, pickIdeas, protectiveStop, screenFailures, type ScreenCandidate } from './action-plan';
import { buildEvidence, OI_NOT_FNO } from './evidence';
import { holdingCheck, okTrend } from './review.fixtures';
import type { BalanceRead, Evidence, HoldingCheck, OiEvidence } from './types';

const NOW = new Date('2026-11-02T08:00:00.000Z');

const oi = (status: OiEvidence['status'], buildup: OiEvidence['buildup'] = null): OiEvidence => ({ status, source: 'BROKER', sessions: 5, pricePct: buildup === 'SHORT_BUILDUP' ? -4 : 4, oiPct: 9, buildup, days: [] });
const strongTrend = okTrend({ dma20: 140, dma50: 130, dma200: 110, high52w: 155, low52w: 90, ret6m: 30, ret1m: 5, atr14: 4, lastClose: 145 });
const downTrend = okTrend({ dma20: 70, dma50: 80, dma200: 100, high52w: 160, low52w: 60, ret6m: -30, ret1m: -6, atr14: 3, lastClose: 65 });
const ev = (over: Partial<Evidence> & { t?: typeof strongTrend; price?: number } = {}): Evidence => ({
  ...buildEvidence({ trend: over.t ?? strongTrend, price: over.price ?? 145, news: [], oi: OI_NOT_FNO, events: [], sector: 'IT' }),
  ...over,
});
const bear = { at: '2026-11-01T05:00:00.000Z', headline: 'Acme Q2 miss', direction: 'BEAR', magnitude: 'HIGH', oneLine: '' };

describe('protectiveStop', () => {
  it('2×ATR below the price, clamped to 3–12%; 8% without ATR; ₹0.05 tick', () => {
    expect(protectiveStop(100, 2).stop).toBe(96);
    expect(protectiveStop(100, 0.5).stop).toBe(97); // 2×0.5 = 1 < 3% floor
    expect(protectiveStop(100, 10).stop).toBe(88); // 20 > 12% cap
    expect(protectiveStop(100, null).stop).toBe(92);
    expect(protectiveStop(123.47, 1.11).stop).toBe(119.75); // 3% floor: 123.47 − 3.70 = 119.77 → tick down
  });
});

describe('classifyHolding', () => {
  const capital = 100_000;
  const dead = holdingCheck({ symbol: 'DEAD-EQ', qty: 100, ltp: 65, pnlPct: -35, pnl: -3500, daysHeld: 120 });

  it('EXIT needs all three: dead money, below the 200-DMA and negative news or adverse OI', () => {
    const e = ev({ t: downTrend, price: 65, oi: oi('ADVERSE', 'SHORT_BUILDUP') });
    const v = classifyHolding(dead, e, capital, NOW);
    expect(v.recommendation).toBe('EXIT');
    expect(v.sellQty).toBe(100);
    expect(v.reasons.join(' ')).toMatch(/dead money/);
  });

  it('dead + below 200-DMA but no negative flow → SET_STOP (two of three), never EXIT', () => {
    const v = classifyHolding(dead, ev({ t: downTrend, price: 65 }), capital, NOW);
    expect(v.recommendation).toBe('SET_STOP');
    expect(v.reasons.join(' ')).toMatch(/Two of the three exit conditions/);
  });

  it('negative news alone never makes an EXIT (news is context only)', () => {
    const fresh = holdingCheck({ symbol: 'NEWS-EQ', qty: 10, ltp: 145, pnlPct: 5, daysHeld: 10 });
    const v = classifyHolding(fresh, ev({ news: 'NEGATIVE', newsItems: [bear] }), capital, NOW);
    expect(v.recommendation).toBe('SET_STOP');
    expect(v.addEligible).toBe(false);
  });

  it('TRIM anything over the 15% weight cap, down to about the cap', () => {
    const big = holdingCheck({ symbol: 'BIG-EQ', qty: 200, ltp: 100, pnlPct: 10 }); // ₹20,000 = 20% of 1L
    const v = classifyHolding(big, ev({ price: 100 }), capital, NOW);
    expect(v.recommendation).toBe('TRIM');
    expect(v.sellQty).toBe(50); // (20,000 − 15,000) / 100
  });

  it('ADD only when every ADD rule passes', () => {
    const good = holdingCheck({ symbol: 'GOOD-EQ', qty: 20, ltp: 145, pnlPct: 12 });
    const v = classifyHolding(good, ev({ oi: oi('SUPPORTIVE', 'LONG_BUILDUP') }), capital, NOW);
    expect(v.recommendation).toBe('ADD');
    expect(v.addEligible).toBe(true);
  });

  it('no averaging down: a loss beyond −10% blocks an ADD even in a strong trend', () => {
    const losing = holdingCheck({ symbol: 'LOSE-EQ', qty: 20, ltp: 145, pnlPct: -12, daysHeld: 20 });
    const v = classifyHolding(losing, ev({}), capital, NOW);
    expect(v.addEligible).toBe(false);
    expect(v.blocked.join(' ')).toMatch(/no averaging down: position is −?-12%/);
  });

  it('no averaging down: below the 200-DMA is blocked and gets a stop', () => {
    const h = holdingCheck({ symbol: 'D-EQ', qty: 20, ltp: 65, pnlPct: -5, daysHeld: 20 });
    const v = classifyHolding(h, ev({ t: downTrend, price: 65 }), capital, NOW);
    expect(v.recommendation).toBe('SET_STOP');
    expect(v.blocked).toContain('no averaging down: below the 200-DMA');
  });

  it('adverse OI, negative momentum or results within 3 days block an ADD', () => {
    const good = holdingCheck({ symbol: 'GOOD-EQ', qty: 20, ltp: 145, pnlPct: 12 });
    expect(classifyHolding(good, ev({ oi: oi('ADVERSE', 'SHORT_BUILDUP') }), capital, NOW).recommendation).toBe('SET_STOP');
    expect(classifyHolding(good, ev({ momentum: 'NEGATIVE' }), capital, NOW).addEligible).toBe(false);
    const results = classifyHolding(good, ev({ events: [{ kind: 'results', title: 'Q2', at: '2026-11-04T03:45:00.000Z' }] }), capital, NOW);
    expect(results.addEligible).toBe(false);
    expect(results.blocked).toContain('results within 3 days');
  });

  it('HOLD when nothing fires; HOLD without a price', () => {
    const h = holdingCheck({ symbol: 'OK-EQ', qty: 20, ltp: 140, pnlPct: 3 });
    const up = okTrend({ dma20: 138, dma50: 130, dma200: 110, high52w: 200, ret6m: 5, ret1m: 1, lastClose: 140 });
    expect(classifyHolding(h, ev({ t: up, price: 140 }), capital, NOW).recommendation).toBe('HOLD');
    expect(classifyHolding({ ...h, ltp: null }, ev({}), capital, NOW).recommendation).toBe('HOLD');
  });
});

describe('screen', () => {
  const cand = (symbol: string, over: Partial<Evidence> = {}): ScreenCandidate => ({ symbol, exchange: 'NSE', token: symbol, evidence: ev({ oi: oi('SUPPORTIVE', 'LONG_BUILDUP'), ...over }) });

  it('passes the strong-trend rules; fails extended, weak 6m, negative news, adverse OI, results', () => {
    expect(screenFailures(cand('A').evidence, NOW)).toEqual([]);
    expect(screenFailures(ev({ close: 160 }), NOW)).toContain('extended'); // > 20-DMA × 1.08 = 151.2
    expect(screenFailures(ev({ ret6m: 5 }), NOW)).toContain('6m return');
    expect(screenFailures(ev({ news: 'NEGATIVE' }), NOW)).toContain('news');
    expect(screenFailures(ev({ oi: oi('ADVERSE', 'SHORT_BUILDUP') }), NOW)).toContain('oi');
    expect(screenFailures(ev({ oi: oi('ADVERSE', 'SHORT_BUILDUP') }), NOW, { ignoreOi: true })).toEqual([]);
    expect(screenFailures(ev({ events: [{ kind: 'results', title: '', at: '2026-11-03T03:45:00.000Z' }] }), NOW)).toContain('results');
    expect(screenFailures(ev({ t: downTrend, price: 65 }), NOW)).toContain('trend');
  });

  it('score: supportive OI and an unheld sector rank higher', () => {
    const base = cand('A').evidence;
    expect(ideaScore(base, false)).toBeGreaterThan(ideaScore(base, true));
    expect(ideaScore(base, false)).toBeGreaterThan(ideaScore({ ...base, oi: oi('NEUTRAL', 'FLAT') }, false));
  });

  it('picks ≤ 5, one per sector, never a held symbol, no sector already ≥ 25% of capital', () => {
    const cands = [
      cand('HELD'),
      cand('IT1', { sector: 'IT' }),
      cand('IT2', { sector: 'IT', ret6m: 60 }),
      cand('BANK1', { sector: 'Banks' }),
      cand('PHARMA', { sector: 'Pharma' }),
      cand('AUTO', { sector: 'Auto' }),
      cand('METAL', { sector: 'Metals' }),
      cand('ENERGY', { sector: 'Energy' }),
      cand('FULL', { sector: 'Full' }),
    ];
    const picked = pickIdeas(cands, new Set(['HELD']), new Map([['Full', 30]]), NOW).map((c) => c.symbol);
    expect(picked).toHaveLength(PLAN_RULES.maxIdeas);
    expect(picked).not.toContain('HELD');
    expect(picked).not.toContain('FULL');
    expect(picked).toContain('IT2'); // the stronger IT name wins the one IT slot
    expect(picked).not.toContain('IT1');
  });

  it('entry zone: [max(20-DMA, close − ATR), close] with the stop under the zone', () => {
    const z = entryZone(ev({}))!;
    expect(z.high).toBe(145);
    expect(z.low).toBe(141); // max(140, 145 − 4)
    expect(z.stop).toBeLessThan(z.low);
  });
});

describe('buildActionPlan — safe-side sizing', () => {
  const live = (cash: number): BalanceRead => ({ status: 'LIVE', availableCash: cash, asOf: NOW.toISOString() });
  const screen = { universe: 200, fetched: 40, cachedToday: 0, passedTrend: 3, oiChecked: 3, skippedReason: null };
  const plan = (holdings: HoldingCheck[], evidence: Map<string, Evidence>, balance: BalanceRead, candidates: ScreenCandidate[] = []) =>
    buildActionPlan({ holdings, evidence, balance, candidates, screen, brokerCalls: { used: 50, cap: 110 }, dataNotes: [], now: NOW });

  it('keeps the 20% cash buffer, caps an ADD at 5% of capital and the weight cap, records before → after', () => {
    // capital = 50,000 cash + 50,000 holdings = 1,00,000; buffer 20,000; deployable 30,000
    const good = holdingCheck({ symbol: 'GOOD-EQ', token: 'g', qty: 100, ltp: 145, pnlPct: 12 }); // 14,500 = 14.5%
    const other = holdingCheck({ symbol: 'OTHER-EQ', token: 'o', qty: 355, ltp: 100, pnlPct: 1 }); // 35,500 → TRIM
    const evidence = new Map([
      ['g', ev({})],
      ['o', ev({ price: 100, t: okTrend({ dma20: 99, dma50: 95, dma200: 90, high52w: 130, ret6m: 4, ret1m: 0, lastClose: 100 }) })],
    ]);
    const p = plan([good, other], evidence, live(50_000));
    expect(p.sizing.totalCapital).toBe(100_000);
    expect(p.sizing.bufferRupees).toBe(20_000);
    const o = p.holdings.find((h) => h.symbol === 'OTHER-EQ')!;
    expect(o.recommendation).toBe('TRIM');
    expect(o.qty).toBe(205); // (35,500 − 15,000) / 100
    const g = p.holdings.find((h) => h.symbol === 'GOOD-EQ')!;
    // room under the 15% cap is 15,000 − 14,500 = 500 → 3 shares at 145 = 435 < ₹500 minimum → HOLD
    expect(g.recommendation).toBe('HOLD');
    expect(g.blocked[0]).toMatch(/room under the 15% weight cap/);
    expect(p.sizing.freed).toBe(20_500);
    expect(p.sizing.maxWeightAfterPct).toBeLessThanOrEqual(PLAN_RULES.maxWeightPct);
    expect(p.sizing.overCapBefore).toBe(1);
    expect(p.sizing.overCapAfter).toBe(0);
    expect(p.disclaimer).toBe(PLAN_DISCLAIMER);
  });

  it('an ADD is sized to min(5% of capital, room under the cap, cash above the buffer)', () => {
    const good = holdingCheck({ symbol: 'GOOD-EQ', token: 'g', qty: 20, ltp: 145, pnlPct: 12 }); // 2,900
    const p = plan([good], new Map([['g', ev({})]]), live(97_100)); // capital 1,00,000
    const g = p.holdings[0];
    expect(g.recommendation).toBe('ADD');
    expect(g.qty).toBe(34); // floor(5,000 / 145)
    expect(g.cashImpact).toBe(4930);
    expect(g.weightAfterPct).toBeCloseTo(7.8, 1);
    expect(p.sizing.cashPctAfter).toBeCloseTo(92.2, 1);
  });

  it('no cash above the buffer → ideas are a watchlist (qty 0), nothing spent', () => {
    // 7 holdings of ₹10,000 (13.7% each, under the cap) + ₹3,000 cash: capital 73,000, buffer 14,600 > cash
    const hs = Array.from({ length: 7 }, (_, i) => holdingCheck({ symbol: 'X' + i + '-EQ', token: 'x' + i, qty: 100, ltp: 100, pnlPct: 2 }));
    const xEv = ev({ price: 100, t: okTrend({ dma20: 99, dma50: 95, dma200: 90, high52w: 130, ret6m: 4, ret1m: 0, lastClose: 100 }) });
    const idea: ScreenCandidate = { symbol: 'NEW', exchange: 'NSE', token: 'n', evidence: ev({ sector: 'Pharma', oi: oi('SUPPORTIVE', 'LONG_BUILDUP') }) };
    const p = plan(hs, new Map(hs.map((h) => [h.token, xEv])), live(3_000), [idea]);
    expect(p.holdings.every((h) => h.recommendation === 'HOLD')).toBe(true);
    expect(p.ideas).toHaveLength(1);
    expect(p.ideas[0].qty).toBe(0);
    expect(p.ideas[0].reasons.join(' ')).toMatch(/watchlist/);
    expect(p.sizing.spent).toBe(0);
    expect(p.sizing.notes.join(' ')).toMatch(/No cash above the 20% buffer/);
    // nothing is weak by the rules, so no cash-raising candidate is named
    expect(p.sizing.raiseCash).toEqual({ needed: 11_600, covered: 0, candidates: [] });
  });

  it('new ideas get ≤ 5% of capital each and a stop; risk to stops adds up', () => {
    const idea = (s: string, sector: string): ScreenCandidate => ({ symbol: s, exchange: 'NSE', token: s, evidence: ev({ sector, oi: oi('SUPPORTIVE', 'LONG_BUILDUP') }) });
    const p = plan([], new Map(), live(100_000), [idea('A', 'Pharma'), idea('B', 'Auto')]);
    expect(p.ideas).toHaveLength(2);
    for (const i of p.ideas) {
      expect(i.amount).toBeLessThanOrEqual(5_000);
      expect(i.qty).toBe(34);
      expect(i.stop).toBeLessThan(i.entryLow);
    }
    expect(p.sizing.riskToStops).toBeCloseTo(p.ideas.reduce((s, i) => s + i.riskRupees, 0), 2);
    expect(p.sizing.cashPctAfter).toBeCloseTo(100 - (2 * 34 * 145) / 1000, 1);
  });

  it('cash below the buffer: names the weakest holdings to sell first (dead + down, then down, then dead), larger first, until covered', () => {
    const mk = (s: string, value: number, pnlPct: number) =>
      holdingCheck({ symbol: `${s}-EQ`, token: s, qty: value / 100, ltp: 100, pnlPct, daysHeld: 120 });
    // every position under the 15% cap (≤ 9,000 of 66,000), so nothing is trimmed
    const hs = [mk('A', 8_000, -30), mk('B', 8_000, -5), mk('C', 8_000, -25), mk('D', 8_000, 3), mk('E', 9_000, -25), mk('F', 8_000, 2), mk('G', 8_000, 1), mk('H', 8_000, 4)];
    const down = ev({ t: { ...downTrend, lastClose: 100, dma200: 120, dma50: 110 }, price: 100 });
    const up = ev({ price: 100, t: okTrend({ dma20: 99, dma50: 95, dma200: 90, high52w: 130, ret6m: 4, ret1m: 0, lastClose: 100 }) });
    const evidence = new Map(hs.map((h) => [h.token, ['A', 'B', 'E'].includes(h.token) ? down : up]));
    const p = plan(hs, evidence, live(1_000)); // capital 66,000 → buffer 13,200, short 12,200
    const r = p.sizing.raiseCash!;
    expect(r.needed).toBe(12_200);
    expect(r.candidates.map((c) => c.symbol)).toEqual(['E-EQ', 'A-EQ']); // dead + down, larger first; 17,000 covers it
    expect(r.candidates[0].why).toBe('dead money and below the long trend');
    const p2 = plan(hs, evidence, live(0));
    expect(p2.sizing.raiseCash!.covered).toBe(17_000);
    expect(p.holdings.find((h) => h.symbol === 'E-EQ')!.recommendation).toBe('SET_STOP'); // informational only
  });

  it('unknown balance → ₹0 cash assumed and said so; EXIT frees cash and lowers the downtrend share', () => {
    const dead = holdingCheck({ symbol: 'DEAD-EQ', token: 'd', qty: 100, ltp: 65, pnlPct: -35, daysHeld: 120 });
    const p = plan([dead], new Map([['d', ev({ t: downTrend, price: 65, oi: oi('ADVERSE', 'SHORT_BUILDUP') })]]), { status: 'NO_DATA', availableCash: null, asOf: null, reason: 'NO_FEED_SESSION' });
    expect(p.sizing.notes[0]).toMatch(/could not be read/);
    expect(p.holdings[0].recommendation).toBe('EXIT');
    expect(p.holdings[0].stop).toBeNull();
    expect(p.sizing.freed).toBe(6500);
    expect(p.sizing.downTrendPctBefore).toBe(100);
    expect(p.sizing.downTrendPctAfter).toBe(0);
    expect(p.counts.EXIT).toBe(1);
    expect(actionPlanDigest(p)).toMatch(/1 exit.*exit DEAD.*cash unknown/);
  });
});
