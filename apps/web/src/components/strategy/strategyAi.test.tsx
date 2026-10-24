import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EMPTY_SETTINGS,
  backtestAggregates,
  buildState,
  createClickGate,
  editPatch,
  isEditField,
  outcomeMessage,
  type BuilderSnapshot,
  type StrategyReview,
} from './strategyAi';
import { StrategyAiReviewCard } from './StrategyAiReviewCard';
import { StrategyChecklist } from './StrategyChecklist';

const snap = (over: Partial<BuilderSnapshot> = {}): BuilderSnapshot => ({
  mode: 'visual',
  name: 'Dip buy',
  description: '',
  timeframe: '15m',
  segment: 'OPTIONS',
  instrument: 'NIFTY',
  code: 'rsi = RSI(close, 14)',
  indicators: [{ id: 'i1', name: 'RSI', params: { period: 14 } }],
  entryRules: [],
  exitRules: [],
  settings: { ...EMPTY_SETTINGS, stopLossKind: 'ATR', stopLossValue: 1.5 },
  ...over,
});

describe('buildState', () => {
  it('blanks the other editor so nothing leaks across modes', () => {
    expect(buildState(snap()).code).toBe('');
    const script = buildState(snap({ mode: 'script' }));
    expect(script.indicators).toEqual([]);
    expect(script.code).toBe('rsi = RSI(close, 14)');
  });
});

describe('editPatch', () => {
  it('applies a whitelisted settings edit', () => {
    expect(editPatch(snap(), { field: 'settings.targetValue', value: 3, reason: '' })).toEqual({
      settings: { ...snap().settings, targetValue: 3 },
    });
  });
  it('applies a top-level edit', () => {
    expect(editPatch(snap(), { field: 'timeframe', value: '1h', reason: '' })).toEqual({ timeframe: '1h' });
  });
  it('refuses unknown fields', () => {
    expect(isEditField('code')).toBe(false);
    expect(editPatch(snap(), { field: 'code', value: 'x', reason: '' })).toBeNull();
    expect(editPatch(snap(), { field: 'settings.__proto__', value: 1, reason: '' })).toBeNull();
  });
  it('suggestions only fill empty fields', () => {
    expect(editPatch(snap(), { field: 'settings.stopLossValue', value: 9, reason: '' }, { onlyIfEmpty: true })).toBeNull();
    expect(editPatch(snap(), { field: 'settings.sessionStart', value: '09:20', reason: '' }, { onlyIfEmpty: true })).not.toBeNull();
    expect(editPatch(snap({ instrument: '' }), { field: 'instrument', value: 'BANKNIFTY', reason: '' }, { onlyIfEmpty: true })).toEqual({ instrument: 'BANKNIFTY' });
  });
});

describe('backtestAggregates', () => {
  const results = { totalTrades: 12, winRate: 50, totalReturnPercent: 3, maxDrawdown: 2, sharpeRatio: 1, trades: [{ pnl: 1 }] };
  it('sends aggregates only, and only for this strategy', () => {
    expect(backtestAggregates('Dip buy', { strategy: 'dip buy' }, results)).toEqual({ totalTrades: 12, winRate: 50, totalReturnPercent: 3, maxDrawdown: 2, sharpeRatio: 1 });
    expect(backtestAggregates('Dip buy', { strategy: 'rsi-reversal' }, results)).toBeNull();
  });
});

describe('createClickGate', () => {
  it('allows one in flight and debounces re-clicks', async () => {
    let t = 0;
    const gate = createClickGate(1000, () => t);
    let release!: () => void;
    const first = gate.run(() => new Promise<string>((r) => (release = () => r('a'))));
    expect(await gate.run(async () => 'b')).toBeUndefined(); // in flight
    release();
    expect(await first).toBe('a');
    t = 500;
    expect(await gate.run(async () => 'c')).toBeUndefined(); // too soon
    t = 1500;
    expect(await gate.run(async () => 'd')).toBe('d');
  });
});

describe('outcomeMessage', () => {
  it('surfaces blocked / busy messages and nothing for answers', () => {
    const ai = { allowed: true, remaining: 3, dailyCap: 30 };
    expect(outcomeMessage({ status: 'busy', message: 'Claude is busy', ai })).toBe('Claude is busy');
    expect(outcomeMessage({ status: 'cached', result: {}, ai })).toBeNull();
  });
});

describe('rendering', () => {
  const review: StrategyReview = {
    summary: 'Buys oversold dips on NIFTY.',
    strengths: ['Defined stop'],
    risks: ['Fees'],
    regimes: { worksIn: ['ranging'], failsIn: ['trending down'] },
    suggestions: [{ field: 'settings.targetValue', value: 2.5, reason: 'Closer target' }],
    confidence: 65,
    disclaimer: 'Not financial advice.',
    rejectedSuggestions: 0,
  };
  it('review card shows the summary, an apply button per edit and the disclaimer', () => {
    const html = renderToStaticMarkup(<StrategyAiReviewCard review={review} cached applied={new Set()} onApply={() => undefined} />);
    expect(html).toContain('Buys oversold dips');
    expect(html).toContain('Target → 2.5');
    expect(html).toContain('Apply');
    expect(html).toContain('cached answer');
    expect(html).toContain('Not financial advice.');
  });
  it('checklist shows errors with their details', () => {
    const html = renderToStaticMarkup(
      <StrategyChecklist
        loading={false}
        error={null}
        report={{ errors: 1, warnings: 0, items: [{ id: 'stop-loss', status: 'error', label: 'Has a stop-loss', details: ['No stop-loss'] }] }}
      />,
    );
    expect(html).toContain('1 to fix');
    expect(html).toContain('No stop-loss');
  });
});
