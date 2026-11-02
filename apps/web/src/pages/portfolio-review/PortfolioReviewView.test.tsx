import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bucket, PortfolioReview } from '@/types/portfolioReview.types';
import { PortfolioReviewView } from './PortfolioReviewPage';

const bucket = (key: string, net: number): Bucket => ({ key, trades: 3, wins: 1, losses: 2, gross: net + 100, charges: 100, net, winRate: 33.3, avgNet: net / 3 });

const review: PortfolioReview = {
  userId: 'u1',
  generatedAt: '2026-11-02T08:00:00.000Z',
  headline: {
    realisedGross: -99274,
    charges: 21676,
    realisedNet: -120950,
    unrealised: -78802,
    unrealisedHoldings: -78802,
    unrealisedPositions: 0,
    total: -199752,
    trades: 239,
    wins: 92,
    losses: 147,
    winRate: 38.5,
    avgWin: 2228,
    avgLoss: -2217,
    profitFactor: 0.63,
    expectancy: -506,
    largestLosses: [{ symbol: 'KEI29SEP265800CE', net: -47633, exitDay: '2026-09-30', segment: 'OPTIONS', closedBy: 'EXPIRY' }],
    byMonth: [{ month: '2026-10', trades: 50, gross: -42764, charges: 3651, net: -46415 }],
    openHoldings: 1,
    openPositions: 0,
    holdingsCost: 15143,
    holdingsValue: 9983,
    trackedSince: '2026-07-11',
  },
  breakdowns: {
    bySegment: [bucket('OPTIONS', -71348)],
    byUnderlying: [bucket('KEI', -47633)],
    byHoldingPeriod: [bucket('>5D', -110781)],
    byClosedBy: [bucket('EXPIRY', -65890)],
    byOpenedBy: [bucket('MANUAL', -120950)],
    byOptionDte: [bucket('1-2 days', -24598)],
    byOptionPremium: [],
    byOptionType: [bucket('CE', -143831)],
    byEntryTime: [bucket('10:00-12:00', -60229)],
  },
  patterns: [
    { id: 'NO_STOP', title: 'Losses without a stop', finding: '13 trades lost ≥50% of the premium.', severity: 'HIGH', rupees: 98989, evidence: {}, examples: ['KEI29SEP265800CE −₹47,633'] },
    { id: 'AVERAGING_DOWN', title: 'Averaging down', finding: 'None.', severity: 'OK', rupees: 0, evidence: {}, examples: [] },
  ],
  holdings: [
    {
      symbol: 'IVALUE-EQ',
      exchange: 'NSE',
      token: '1',
      qty: 50,
      avgCost: 302.87,
      cost: 15143,
      ltp: 199.67,
      value: 9983,
      pnl: -5160,
      pnlPct: -34.1,
      daysHeld: 113,
      firstTracked: '2026-07-11',
      sharePct: 100,
      averagedDown: false,
      trend: { status: 'NO_DATA', reason: 'NO_FEED_SESSION', bars: 0, dma50: null, dma200: null, high52w: null, low52w: null, ret6m: null },
      tags: ['DEAD-MONEY', 'CONCENTRATED'],
      tag: 'DEAD-MONEY',
      note: '-34.1% after ≥113 days — decide: exit, or set a stop and a review date',
    },
  ],
  suggestions: [
    { id: 'HELD_TO_EXPIRY', rank: 1, category: 'RISK', title: 'Decide an exit before expiry day', detail: 'Set a calendar rule.', evidence: '15 positions ran into expiry and netted −₹65,890.', impactRupees: 65890 },
  ],
  dataQuality: {
    notes: ['218 of 239 realised trades use the last tick as the exit price.'],
    invalidRows: 12,
    invalidClaimedPnl: 120073,
    churnRows: 406,
    churnClaimedPnl: -289543,
    holdingLegs: 42,
    lastTickExits: 218,
    fillExits: 21,
    chargesMethod: 'Estimated with the app charge model.',
  },
  digest: 'Portfolio review digest paragraph.',
  summary: { status: 'PENDING', text: null, reason: 'still being written — reload in a minute' },
};

const render = (r: PortfolioReview) => renderToStaticMarkup(<PortfolioReviewView r={r} onRefresh={() => undefined} refreshing={false} />);

describe('PortfolioReviewView', () => {
  it('renders headline cards in ₹ en-IN, suggestions, loss sources, patterns, holdings and data quality', () => {
    const html = render(review);
    expect(html).toContain('−₹1,99,752');
    expect(html).toContain('−₹1,20,950');
    expect(html).toContain('Decide an exit before expiry day');
    expect(html).toContain('Ran into expiry');
    expect(html).toContain('Losses without a stop');
    expect(html).toContain('IVALUE-EQ');
    expect(html).toContain('DEAD-MONEY');
    expect(html).toContain('218 of 239 realised trades');
    expect(html).not.toContain('Averaging down</span>'); // OK patterns are listed only in the "no issue" line
  });
  it('falls back to the digest while the AI summary is pending, and shows it when ready', () => {
    expect(render(review)).toContain('Portfolio review digest paragraph.');
    const ok = render({ ...review, summary: { status: 'OK', text: '**Options** are the leak.', reason: null } });
    expect(ok).toContain('<strong>Options</strong>');
  });
});
