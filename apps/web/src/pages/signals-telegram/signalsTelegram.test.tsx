import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { channelStatsLine, decisionWhy, fundsLine, modeBadge, openOrders, outcomeLine, paperState, planLine, skipLabel, type SignalOverview } from './signalsTelegram';
import { SignalsTelegramView } from './SignalsTelegramView';

const overview: SignalOverview = {
  mode: 'live',
  caps: { maxLots: 2, maxLossPerTrade: 2000, maxTradesPerDay: 3, dailyLossStop: 10000, entryTolerancePct: 3, product: 'INTRADAY' },
  slEnforcement: { ok: true, detail: 'price trigger → AI exit' },
  decisions: [
    {
      id: 'd1', signalId: 's1', evaluation: 1, decidedAt: '2026-10-23T05:00:00Z', mode: 'live', status: 'DONE', channel: 'Alpha', underlying: 'NIFTY',
      agreeCount: 3, conflict: false, decision: 'TAKE', skipReason: null, gate: [{ name: 'risk_cap', ok: true, required: true, detail: '2 lots' }],
      judge: { verdict: 'TAKE', effectiveConfidence: 75, reasons: ['PCR supports', 'above VWAP', 'third'] },
      plan: { tradingsymbol: 'NIFTY28OCT2625000CE', side: 'BUY', qty: 150, lots: 2, limitPrice: 101.5, sl: 90, targets: [120], riskRupees: 1725 },
    },
    {
      id: 'd2', signalId: 's2', evaluation: 1, decidedAt: '2026-10-23T06:00:00Z', mode: 'live', status: 'DONE', channel: 'Beta', underlying: 'BANKNIFTY',
      agreeCount: 1, conflict: true, decision: 'SKIP', skipReason: 'risk_cap', gate: [{ name: 'risk_cap', ok: false, required: true, detail: 'one_lot_exceeds_risk_cap: 1 lot risks ₹2400' }],
      judge: null, plan: null,
    },
  ],
  orders: [
    { id: 'o1', decisionId: 'd1', tradingsymbol: 'NIFTY28OCT2625000CE', side: 'BUY', qty: 150, limitPrice: 101.5, sl: 90, targets: [120], status: 'FILLED', statusReason: null, fillPrice: 101.4, filledAt: null, trackerStatus: 'OPEN', lastLtp: 108, pnl: 990, createdAt: '' },
    { id: 'o2', decisionId: 'd0', tradingsymbol: 'X', side: 'BUY', qty: 75, limitPrice: 50, sl: 45, targets: [], status: 'FILLED', statusReason: null, fillPrice: 50, filledAt: null, trackerStatus: 'CLOSED', lastLtp: 55, pnl: 375, createdAt: '' },
  ],
  channels: [{ id: 'c1', title: 'Alpha', stats: { hitRate: 0.42, n: 19 } }],
};

describe('signals-telegram format', () => {
  it('mode badge', () => {
    expect(modeBadge('live')).toEqual({ label: 'LIVE', variant: 'danger' });
    expect(modeBadge('shadow').label).toBe('SHADOW');
    expect(modeBadge('off').label).toBe('OFF');
  });
  it('why a decision went the way it did', () => {
    expect(decisionWhy(overview.decisions[1])).toMatch(/one_lot_exceeds/);
    expect(decisionWhy(overview.decisions[0])).toBe('PCR supports; above VWAP');
    expect(skipLabel('judge_unavailable')).toBe('AI judge unavailable');
    expect(planLine(overview.decisions[0].plan)).toBe('BUY NIFTY28OCT2625000CE x150 @ 101.5 SL 90 T 120 (risk ₹1725)');
  });
  it('open trades exclude closed trackers', () => {
    expect(openOrders(overview.orders).map((o) => o.id)).toEqual(['o1']);
  });
  it('channel stats', () => {
    expect(channelStatsLine({ hitRate: 0.42, n: 19 })).toBe('hit 42% · n 19');
    expect(channelStatsLine(null)).toBe('no stats yet');
  });
});

const paperOverview: SignalOverview = {
  ...overview,
  paperOnNoFunds: { enabled: true, store: 'user_settings.signalPaperOnNoFunds' },
  decisions: [
    ...overview.decisions,
    {
      id: 'd3', signalId: 's3', evaluation: 1, decidedAt: '2026-10-23T07:00:00Z', mode: 'live', status: 'DONE', channel: 'Gamma', underlying: 'NIFTY',
      agreeCount: 1, conflict: false, decision: 'PAPER', skipReason: 'insufficient_funds',
      gate: [{ name: 'funds', ok: false, required: true, detail: 'INSUFFICIENT: available ₹9,000 vs need ₹15,377' }],
      judge: { verdict: 'TAKE', effectiveConfidence: 70, reasons: ['ok'] },
      plan: { tradingsymbol: 'NIFTY28OCT2625000CE', side: 'BUY', qty: 150, lots: 2, limitPrice: 101.5, sl: 90, targets: [120], riskRupees: 1725 },
    },
  ],
  paper: {
    lookbackDays: 30,
    rows: [
      {
        decisionId: 'd3', decidedAt: '2026-10-23T07:00:00Z', channel: 'Gamma', underlying: 'NIFTY',
        plan: { tradingsymbol: 'NIFTY28OCT2625000CE', side: 'BUY', qty: 150, limitPrice: 101.5, sl: 90, targets: [120] },
        funds: { available: 9000, required: 15377.25, ok: false, method: 'premium' }, trigger: 'funds_check', paperError: null,
        trade: { id: 't1', status: 'CLOSED', entryPrice: 101.5, exitPrice: 120, pnl: 2775, exitReasonTag: 'HIT_TARGET', exitTime: null },
      },
      {
        decisionId: 'd4', decidedAt: '2026-10-22T07:00:00Z', channel: 'Gamma', underlying: 'BANKNIFTY', plan: null,
        funds: null, trigger: 'broker_reject', paperError: 'Max concurrent positions reached', trade: null,
      },
    ],
    summary: { n: 2, open: 0, closed: 1, wins: 1, losses: 0, noTrade: 1, pnl: 2775, realised: 2775, winRate: 1 },
    live: { n: 1, open: 0, closed: 1, wins: 0, losses: 1, noTrade: 0, pnl: -500, realised: -500, winRate: 0 },
  },
};

describe('paper (no funds)', () => {
  it('formats outcomes, states and funds', () => {
    expect(outcomeLine(paperOverview.paper!.summary)).toBe('1 closed · 1W/0L · P&L ₹2,775');
    expect(outcomeLine(paperOverview.paper!.live)).toBe('1 closed · 0W/1L · P&L −₹500');
    expect(outcomeLine(undefined)).toBe('none yet');
    expect(paperState(paperOverview.paper!.rows[0])).toEqual({ label: 'target @ 120 · ₹2,775', tone: 'good' });
    expect(paperState(paperOverview.paper!.rows[1]).label).toBe('not opened: Max concurrent positions reached');
    expect(fundsLine(paperOverview.paper!.rows[0].funds)).toBe('need ₹15,377, available ₹9,000');
    expect(decisionWhy(paperOverview.decisions[2])).toMatch(/^paper trade instead — INSUFFICIENT/);
    expect(skipLabel('insufficient_funds')).toBe('not enough funds');
  });

  it('renders the toggle, the PAPER decision and a separate Paper (no funds) section with live alongside', () => {
    const html = renderToStaticMarkup(<SignalsTelegramView data={paperOverview} onTogglePaper={() => undefined} />);
    expect(html).toContain('data-testid="paper-toggle"');
    expect(html).toContain('Turn off (skip instead)');
    expect(html).toContain('Paper (no funds)');
    expect(html.match(/data-testid="paper-row"/g)).toHaveLength(2);
    expect(html).toContain('1 closed · 1W/0L · P&amp;L ₹2,775');
    expect(html).toContain('0W/1L');
    expect(html).toContain('>PAPER<');
  });

  it('without the new fields (older API) nothing extra renders', () => {
    const html = renderToStaticMarkup(<SignalsTelegramView data={overview} />);
    expect(html).not.toContain('paper-section');
    expect(html).not.toContain('paper-toggle');
  });
});

describe('SignalsTelegramView', () => {
  it('renders mode, caps, decisions, open trades and channels', () => {
    const html = renderToStaticMarkup(<SignalsTelegramView data={overview} />);
    expect(html).toContain('LIVE');
    expect(html).toContain('max 2 lots');
    expect(html).toContain('₹2,000/trade');
    expect(html).toContain('CONFLICT');
    expect(html).toContain('risk above cap');
    expect(html.match(/data-testid="signal-open-trade"/g)).toHaveLength(1);
    expect(html).toContain('hit 42%');
  });
});
