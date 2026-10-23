import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { channelStatsLine, decisionWhy, modeBadge, openOrders, planLine, skipLabel, type SignalOverview } from './signalsTelegram';
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
