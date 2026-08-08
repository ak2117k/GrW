import { describe, it, expect } from 'vitest';
import {
  deriveTradePlanView,
  sanitizeReason,
  tradePlanLines,
} from './tradePlanView';
import type { TradePlan, TradeTrigger } from '@/hooks/useChartContext';
import type { AnalysisDto } from '@/components/stock-overview/SetupContextCard';

function trigger(over: Partial<TradeTrigger> = {}): TradeTrigger {
  return {
    side: 'BUY',
    triggerPrice: 24_630,
    levelSource: 'PDH',
    entry: 24_635,
    stoploss: 24_590,
    target: 24_720,
    rr: 2,
    state: 'pending',
    reason: 'Break of the previous day high with follow-through.',
    ...over,
  };
}

const ABOVE = trigger();
const BELOW = trigger({
  side: 'SELL',
  triggerPrice: 24_522,
  levelSource: 'PDL',
  entry: 24_518,
  stoploss: 24_562,
  target: 24_432,
  rr: 2.2,
});

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return { active: null, above: null, below: null, ...over };
}

const SETUP: AnalysisDto = {
  kind: 'setup',
  symbol: 'NIFTY',
  side: 'BUY',
  entry: 24_635,
  stoploss: 24_590,
  target: 24_720,
  levelType: 'PDH',
  setupType: 'BREAKOUT',
  grade: 'A',
  atr14: 60,
  volumeRatio: 0,
  levels: {
    pdh: 24_630,
    pdl: 24_522,
    orh: null,
    orl: null,
    vwap: 24_580,
    todayHigh: 24_640,
    todayLow: 24_500,
    atr14: 60,
  },
  reason: 'Broke PDH and held above it.',
};

const NO_SETUP: AnalysisDto = {
  kind: 'no-setup',
  // The exact string the card used to leak to the user.
  reason: 'reject:confirmation {"type":"ROUND","volumeRatio":0}',
  levels: null,
};

describe('deriveTradePlanView', () => {
  it('says loading while no response has landed', () => {
    const view = deriveTradePlanView({
      plan: undefined,
      analysis: null,
      source: undefined,
      loading: true,
    });
    expect(view.kind).toBe('loading');
  });

  it('renders the trade when a trigger is active', () => {
    const view = deriveTradePlanView({
      plan: plan({ active: trigger({ state: 'active' }), above: ABOVE, below: BELOW }),
      analysis: SETUP,
      source: 'ok',
      loading: false,
    });
    expect(view).toMatchObject({
      kind: 'active',
      trade: {
        side: 'BUY',
        levelSource: 'PDH',
        entryText: '24,635',
        stoplossText: '24,590',
        targetText: '24,720',
        rrText: '1:2.0',
        grade: 'A',
      },
    });
  });

  it('falls back to the live setup when the plan carries no active trigger', () => {
    const view = deriveTradePlanView({
      plan: plan(),
      analysis: SETUP,
      source: 'ok',
      loading: false,
    });
    // Same arithmetic: |24720-24635| / |24635-24590| = 85/45 = 1.89
    expect(view).toMatchObject({
      kind: 'active',
      trade: { side: 'BUY', entryText: '24,635', rrText: '1:1.9', grade: 'A' },
    });
  });

  it('renders BOTH forward triggers when nothing is active', () => {
    const view = deriveTradePlanView({
      plan: plan({ above: ABOVE, below: BELOW }),
      analysis: NO_SETUP,
      source: 'ok',
      loading: false,
    });
    if (view.kind !== 'triggers') throw new Error(`expected triggers, got ${view.kind}`);
    expect(view.above?.text).toBe('Above 24,630 (PDH) → BUY  SL 24,590  T 24,720  1:2.0');
    expect(view.below?.text).toBe('Below 24,522 (PDL) → SELL  SL 24,562  T 24,432  1:2.2');
  });

  it('renders one side when only one qualifies, and fabricates nothing on the other', () => {
    const view = deriveTradePlanView({
      plan: plan({ above: ABOVE }),
      analysis: NO_SETUP,
      source: 'ok',
      loading: false,
    });
    if (view.kind !== 'triggers') throw new Error(`expected triggers, got ${view.kind}`);
    expect(view.above?.triggerPrice).toBe(24_630);
    expect(view.below).toBeNull();
  });

  it('says so in words when neither side qualifies — no JSON, no debug string', () => {
    const view = deriveTradePlanView({
      plan: plan(),
      analysis: NO_SETUP,
      source: 'empty',
      loading: false,
    });
    if (view.kind !== 'none') throw new Error(`expected none, got ${view.kind}`);
    expect(view.message).toMatch(/no trade set up/i);
    expect(view.message).not.toContain('{');
    expect(view.message).not.toContain('reject');
  });

  it('distinguishes a failed plan source from "nothing set up"', () => {
    const view = deriveTradePlanView({
      plan: plan(),
      analysis: NO_SETUP,
      source: 'failed',
      loading: false,
    });
    expect(view).toMatchObject({ kind: 'unavailable' });
  });

  it('never lets a raw debug payload reach the rendered output', () => {
    const raw = 'reject:confirmation {"type":"ROUND","volumeRatio":0}';
    const view = deriveTradePlanView({
      plan: plan({ active: trigger({ state: 'active', reason: raw }) }),
      analysis: { ...SETUP, reason: raw },
      source: 'ok',
      loading: false,
    });
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain('reject:');
    expect(rendered).not.toContain('volumeRatio');
    if (view.kind !== 'active') throw new Error('expected active');
    expect(view.trade.reason).toBe('');
  });

  it('drops a level book that has not warmed (price 0) rather than drawing it', () => {
    const view = deriveTradePlanView({
      plan: plan({ above: trigger({ triggerPrice: 0 }) }),
      analysis: NO_SETUP,
      source: 'ok',
      loading: false,
    });
    expect(view.kind).toBe('none');
  });
});

describe('sanitizeReason', () => {
  it('keeps a plain sentence', () => {
    expect(sanitizeReason('Broke PDH and held above it.')).toBe(
      'Broke PDH and held above it.',
    );
  });

  it('drops anything carrying a payload or a reject prefix', () => {
    expect(sanitizeReason('reject:confirmation {"type":"ROUND"}')).toBe('');
    expect(sanitizeReason('reject: distance')).toBe('');
    expect(sanitizeReason('["a"]')).toBe('');
    expect(sanitizeReason(undefined)).toBe('');
  });
});

describe('tradePlanLines', () => {
  it('draws R and S from the SAME fields the card reads', () => {
    const p = plan({ above: ABOVE, below: BELOW });
    const lines = tradePlanLines(p);
    const view = deriveTradePlanView({
      plan: p,
      analysis: NO_SETUP,
      source: 'ok',
      loading: false,
    });
    if (view.kind !== 'triggers') throw new Error('expected triggers');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'R', value: p.above!.triggerPrice });
    expect(lines[1]).toMatchObject({ type: 'S', value: p.below!.triggerPrice });
    // The drawn price is the card's price, not a parallel computation.
    expect(lines[0].value).toBe(view.above!.triggerPrice);
    expect(lines[1].value).toBe(view.below!.triggerPrice);
    expect(lines[0].label).toBe('R 24,630 PDH');
    expect(lines[1].label).toBe('S 24,522 PDL');
  });

  it('draws nothing on a null side', () => {
    expect(tradePlanLines(plan({ above: ABOVE }))).toHaveLength(1);
    expect(tradePlanLines(plan())).toHaveLength(0);
    expect(tradePlanLines(null)).toHaveLength(0);
    expect(tradePlanLines(undefined)).toHaveLength(0);
  });

  it('refuses a zero/unwarmed trigger price', () => {
    expect(tradePlanLines(plan({ above: trigger({ triggerPrice: 0 }) }))).toHaveLength(0);
  });
});
