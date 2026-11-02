import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionPlan, Bucket, PortfolioReview, ReviewQuota } from '@/types/portfolioReview.types';
import { PortfolioReviewView, ReviewHeader } from './PortfolioReviewPage';

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

const render = (r: PortfolioReview, tab: 'happened' | 'next' = 'happened') => renderToStaticMarkup(<PortfolioReviewView r={r} tab={tab} onTab={() => undefined} />);

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

const trendEv = {
  trend: 'DOWN' as const,
  momentum: 'NEGATIVE' as const,
  close: 199.67,
  dma20: 205,
  dma50: 210,
  dma200: 260,
  ret1m: -4,
  ret6m: -25,
  fromHigh52wPct: 37.6,
  fromLow52wPct: 5,
  atr14: 6,
  news: 'NONE' as const,
  newsItems: [],
  oi: { status: 'NOT_FNO' as const, source: null, sessions: 0, pricePct: null, oiPct: null, buildup: null, days: [] },
  events: [],
  sector: 'Information Technology',
};

const plan: ActionPlan = {
  generatedAt: '2026-11-02T08:00:00.000Z',
  rules: { cashBufferPct: 20, maxWeightPct: 15, maxNewIdeaPct: 5, maxLossToAddPct: -10, minIdeaRet6mPct: 10, maxIdeaExtensionPct: 8 },
  holdings: [
    {
      symbol: 'IVALUE-EQ',
      exchange: 'NSE',
      token: '1',
      recommendation: 'SET_STOP',
      qty: 50,
      heldQty: 50,
      ltp: 199.67,
      value: 9983.5,
      cashImpact: 0,
      stop: 187.65,
      stopBasis: '2×ATR(14) (₹6) below the price',
      pnl: -5160,
      pnlPct: -34.1,
      daysHeld: 113,
      weightPct: 67.4,
      weightAfterPct: 67.4,
      reasons: ['Down -34.1% after 113 days (dead money) — decide a stop and a review date rather than waiting.'],
      blocked: ['no averaging down: below the 200-DMA'],
      chips: [{ label: 'Below 200-DMA', tone: 'bad' }],
      evidence: trendEv,
    },
  ],
  ideas: [
    {
      symbol: 'PERSISTENT',
      exchange: 'NSE',
      token: '9',
      sector: 'Information Technology',
      close: 6120.5,
      qty: 0,
      amount: 0,
      entryLow: 5980,
      entryHigh: 6120.5,
      stop: 5620.25,
      riskRupees: 0,
      score: 30,
      reasons: ['No spare cash above the buffer — a watchlist idea for when cash is freed.'],
      chips: [{ label: 'F&O OI: long buildup', tone: 'good' }],
      evidence: { ...trendEv, trend: 'STRONG_UP', momentum: 'POSITIVE' },
    },
  ],
  sizing: {
    balance: { status: 'LIVE', availableCash: 4827.82, asOf: '2026-11-02T08:00:00.000Z' },
    cash: 4827.82,
    holdingsValue: 9983.5,
    totalCapital: 14811.32,
    cashPctBefore: 32.6,
    cashPctAfter: 32.6,
    bufferRupees: 2962.26,
    freed: 0,
    spent: 0,
    deployableBefore: 1865.56,
    maxWeightBeforePct: 67.4,
    maxWeightAfterPct: 67.4,
    overCapBefore: 1,
    overCapAfter: 1,
    downTrendPctBefore: 67.4,
    downTrendPctAfter: 67.4,
    riskToStops: 601,
    weights: [{ symbol: 'IVALUE-EQ', beforePct: 67.4, afterPct: 67.4 }],
    raiseCash: { needed: 116346, covered: 9983.5, candidates: [{ symbol: 'IVALUE-EQ', value: 9983.5, why: 'dead money and below the long trend' }] },
    notes: ['Sales in the plan free nothing.'],
  },
  screen: { universe: 208, fetched: 40, cachedToday: 0, passedTrend: 3, oiChecked: 3, picked: 1, skippedReason: null },
  brokerCalls: { used: 52, cap: 110 },
  counts: { HOLD: 0, ADD: 0, TRIM: 0, EXIT: 0, SET_STOP: 1 },
  explanation: { status: 'SKIPPED', text: null, reason: 'the AI text is available to the account owner only' },
  disclaimer: 'Analysis, not investment advice: rule-based suggestions from past prices, news and OI — not predictions.',
  dataNotes: ['1 holding(s) are F&O stocks; futures OI read for 0.'],
};

describe('PortfolioReviewView — tabs', () => {
  it('"What you can do next": recommendation badge, qty, stop, chips, sizing before → after, new ideas and the disclaimer', () => {
    const html = render({ ...review, actionPlan: plan }, 'next');
    expect(html).toContain('What you can do next');
    expect(html).toContain('Set stop');
    expect(html).toContain('Keep 50, place a stop');
    expect(html).toContain('₹187.65');
    expect(html).toContain('Below 200-DMA');
    expect(html).toContain('₹4,828'); // available cash, en-IN
    expect(html).toContain('32.6% → 32.6%');
    expect(html).toContain('PERSISTENT');
    expect(html).toContain('Watchlist');
    expect(html).toContain('₹5,980 – ₹6,120.5');
    expect(html).toContain('Analysis, not investment advice');
    expect(html).toContain('Not an add because: no averaging down: below the 200-DMA');
    expect(html).toContain('To restore the 20% buffer (₹1,16,346 short)');
    expect(html).not.toContain('Losses without a stop'); // the other tab
  });
  it('a review stored before the action plan asks for a new run', () => {
    expect(render(review, 'next')).toContain('before the action plan existed');
  });
});

describe('ReviewHeader', () => {
  const quota: ReviewQuota = { usedThisMonth: 1, freeLimit: 1, allowed: true, enforced: false, periodStart: '2026-11', note: '1 free review per month (not enforced yet) — 1 used this month.' };
  it('shows the last review date, the run button and the quota note', () => {
    const html = renderToStaticMarkup(<ReviewHeader lastAt="2026-11-02T08:00:00.000Z" running={false} progress={null} error={null} quota={quota} onRun={() => undefined} />);
    expect(html).toContain('Last review: 02 Nov 2026');
    expect(html).toContain('Run portfolio review');
    expect(html).toContain('not enforced yet');
  });
  it('running: disabled button with progress; errors shown; no review yet', () => {
    const html = renderToStaticMarkup(<ReviewHeader lastAt={null} running progress="Screening F&O stocks" error="boom" quota={null} onRun={() => undefined} />);
    expect(html).toContain('No review yet');
    expect(html).toContain('Running review…');
    expect(html).toContain('disabled');
    expect(html).toContain('Screening F&amp;O stocks');
    expect(html).toContain('boom');
  });
});
