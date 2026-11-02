import { buildEpisodes } from './episodes';
import { holdingChecks, holdingTags, trendFromBars } from './holdings';
import { holdingRow, ist, okTrend } from './review.fixtures';
import type { HoldingTrend } from './types';

const NOW = ist('2026-11-02 13:00');
const bars = (closes: number[]) => closes.map((c) => ({ close: c, high: c * 1.01, low: c * 0.99 }));

describe('trendFromBars', () => {
  it('NO_DATA under 20 candles', () => {
    expect(trendFromBars(bars([1, 2, 3])).status).toBe('NO_DATA');
  });
  it('50/200-DMA, 52w range, 6-month return', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i); // steady uptrend 100 → 349
    const t = trendFromBars(bars(closes));
    expect(t.status).toBe('OK');
    expect(t.dma50).toBeCloseTo(mean(closes.slice(-50)), 2);
    expect(t.dma200).toBeCloseTo(mean(closes.slice(-200)), 2);
    expect(t.high52w).toBeCloseTo(349 * 1.01, 1);
    expect(t.ret6m).toBeCloseTo(((349 - 223) / 223) * 100, 1);
  });
  it('no 200-DMA with fewer than 200 candles', () => {
    expect(trendFromBars(bars(Array.from({ length: 60 }, () => 10))).dma200).toBeNull();
  });
});

function mean(xs: number[]) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

describe('holdingTags', () => {
  const base = { pnlPct: 0, daysHeld: 100, sharePct: 5, ltp: 100, trend: okTrend() };
  it('DEAD-MONEY: ≤ −20% and ≥ 60 days', () => {
    expect(holdingTags({ ...base, pnlPct: -24 })).toContain('DEAD-MONEY');
    expect(holdingTags({ ...base, pnlPct: -24, daysHeld: 30 })).not.toContain('DEAD-MONEY');
    expect(holdingTags({ ...base, pnlPct: -19.9 })).not.toContain('DEAD-MONEY');
  });
  it('WEAK-TREND: below 50-DMA and 200-DMA (or negative 6m return without a 200-DMA)', () => {
    expect(holdingTags({ ...base, ltp: 90, trend: okTrend({ dma50: 100, dma200: 95 }) })).toContain('WEAK-TREND');
    expect(holdingTags({ ...base, ltp: 90, trend: okTrend({ dma50: 100, dma200: 85 }) })).not.toContain('WEAK-TREND');
    expect(holdingTags({ ...base, ltp: 90, trend: okTrend({ dma50: 100, dma200: null, ret6m: -5 }) })).toContain('WEAK-TREND');
  });
  it('STRONG: above 50-DMA, 50 > 200, and in profit', () => {
    expect(holdingTags({ ...base, ltp: 120, pnlPct: 10, trend: okTrend({ dma50: 110, dma200: 100 }) })).toEqual(['STRONG']);
    expect(holdingTags({ ...base, ltp: 120, pnlPct: -1, trend: okTrend({ dma50: 110, dma200: 100 }) })).not.toContain('STRONG');
  });
  it('CONCENTRATED at ≥ 15% of the book', () => {
    expect(holdingTags({ ...base, sharePct: 15 })).toContain('CONCENTRATED');
  });
  it('NO_DATA trend never yields a trend tag', () => {
    const noData: HoldingTrend = { ...okTrend(), status: 'NO_DATA', dma50: null };
    expect(holdingTags({ ...base, ltp: 1, trend: noData })).toEqual([]);
  });
  it('orders tags by priority DEAD-MONEY > WEAK-TREND > CONCENTRATED > STRONG', () => {
    expect(holdingTags({ ...base, pnlPct: -30, sharePct: 20, ltp: 50, trend: okTrend({ dma50: 70, dma200: 80 }) })).toEqual(['DEAD-MONEY', 'WEAK-TREND', 'CONCENTRATED']);
  });
});

describe('holdingChecks', () => {
  it('cost, P&L %, days held since first tracked, share of book and a note', () => {
    const rows = [
      holdingRow('IVALUE-EQ', 302.87, 50, '2026-07-11 18:41', null, 199.67),
      holdingRow('SHADOWFAX-EQ', 231.12, 100, '2026-07-11 18:41', null, 270.7),
    ];
    const ep = buildEpisodes(rows, [], [], NOW).episodes;
    const trends = new Map([
      ['tok-IVALUE', okTrend({ dma50: 210, dma200: 260 })],
      ['tok-SHADOWFAX', okTrend({ dma50: 250, dma200: 240 })],
    ]);
    const [iv, sf] = holdingChecks(ep, trends, NOW);
    expect(iv.symbol).toBe('IVALUE-EQ');
    expect(iv.pnlPct).toBeCloseTo(-34.1, 1);
    expect(iv.daysHeld).toBe(113);
    expect(iv.sharePct).toBeCloseTo((15143.5 / (15143.5 + 23112)) * 100, 1);
    expect(iv.tags).toEqual(['DEAD-MONEY', 'WEAK-TREND', 'CONCENTRATED']);
    expect(iv.note).toMatch(/decide: exit, or set a stop/);
    expect(sf.tags).toEqual(['CONCENTRATED', 'STRONG']); // 60% of a 2-stock book: concentration outranks strength
  });
  it('missing trend is NO_DATA, not an error', () => {
    const ep = buildEpisodes([holdingRow('IDEA-EQ', 13.11, 100, '2026-10-01 10:00', null, 12.25)], [], [], NOW).episodes;
    const [c] = holdingChecks(ep, new Map(), NOW);
    expect(c.trend.status).toBe('NO_DATA');
    expect(c.note).toMatch(/trend unavailable/);
  });
});
