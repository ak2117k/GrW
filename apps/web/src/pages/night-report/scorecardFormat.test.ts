import { describe, expect, it } from 'vitest';
import type { FactorScore, VerdictView } from '@/types/nightReport.types';
import {
  FACTOR_ORDER,
  bandLabel,
  bandVariant,
  factorLabel,
  ideaBadge,
  ideaOutcome,
  ideaSymbolRef,
  orderedFactors,
  pointsTone,
  signedPoints,
  sortIdeasNewestFirst,
  verdictDisagreesWithBand,
  verdictForScorecard,
} from './nightReportFormat';

describe('factor labels and order', () => {
  it('names every factor for a human', () => {
    expect(FACTOR_ORDER.map(factorLabel)).toEqual([
      'Option chain (OI)',
      'FII / DII',
      'India VIX',
      'Expiry / time decay',
      'News',
      'Indicators (EMA 9/20, MACD, RSI)',
      'Market mood',
    ]);
    expect(factorLabel('gift_nifty')).toBe('Gift nifty');
  });

  it('orders factors and fills missing ones in as unavailable', () => {
    const given: FactorScore[] = [
      { name: 'mood', points: -1, value: 'p 0.4', reason: 'r', available: true },
      { name: 'oi', points: 2, value: 'PCR 2.1', reason: 'r', available: true },
    ];
    const out = orderedFactors(given);
    expect(out.map((f) => f.name)).toEqual(FACTOR_ORDER);
    expect(out[0].points).toBe(2);
    expect(out[1]).toMatchObject({ name: 'fii_dii', available: false, points: 0 });
    expect(out[6].points).toBe(-1);
    expect(orderedFactors(null)).toHaveLength(7);
  });
});

describe('points and band', () => {
  it('signs points with a real minus', () => {
    expect([-2, -1, 0, 1, 2].map(signedPoints)).toEqual(['−2', '−1', '0', '+1', '+2']);
    expect(signedPoints(null)).toBe('—');
    expect([-2, 0, 1].map(pointsTone)).toEqual(['neg', 'zero', 'pos']);
  });

  it('labels and colours bands', () => {
    expect(bandLabel('STRONG_SUPPORTS')).toBe('Strongly supports');
    expect(bandLabel('AGAINST')).toBe('Against');
    expect(bandLabel(null)).toBe('No score');
    expect(bandVariant('STRONG_AGAINST')).toBe('danger');
    expect(bandVariant('STRONG_SUPPORTS')).toBe('success');
    expect(bandVariant('WHATEVER')).toBe('neutral');
  });
});

describe('verdictDisagreesWithBand', () => {
  it('flags exit/tighten against a supportive band', () => {
    for (const v of ['EXIT_AT_OPEN', 'TIGHTEN_AT_OPEN', 'EXIT_NOW', 'EXIT_ARMED']) {
      expect(verdictDisagreesWithBand(v, 'SUPPORTS')).toBe(true);
      expect(verdictDisagreesWithBand(v, 'STRONG_SUPPORTS')).toBe(true);
    }
  });

  it('flags a hold against an adverse band', () => {
    expect(verdictDisagreesWithBand('HOLD_OVERNIGHT', 'AGAINST')).toBe(true);
    expect(verdictDisagreesWithBand('HOLD', 'STRONG_AGAINST')).toBe(true);
  });

  it('stays quiet when they agree, the band is neutral, or the verdict is unknown', () => {
    expect(verdictDisagreesWithBand('EXIT_AT_OPEN', 'AGAINST')).toBe(false);
    expect(verdictDisagreesWithBand('HOLD_OVERNIGHT', 'STRONG_SUPPORTS')).toBe(false);
    expect(verdictDisagreesWithBand('EXIT_AT_OPEN', 'NEUTRAL')).toBe(false);
    expect(verdictDisagreesWithBand('ESCALATE', 'SUPPORTS')).toBe(false);
    expect(verdictDisagreesWithBand(null, 'AGAINST')).toBe(false);
    expect(verdictDisagreesWithBand('HOLD', null)).toBe(false);
  });

  it('compares a pre-open scorecard with the pre-open verdict', () => {
    const v = (verdict: string): VerdictView => ({
      verdict,
      confidence: null,
      risk: '',
      plan: null,
      invalidation: null,
      at: '2026-10-20T00:00:00Z',
      window: 'X',
    });
    const overnight = v('HOLD_OVERNIGHT');
    const preOpen = v('EXIT_AT_OPEN');
    const card = (window: 'OVERNIGHT' | 'PRE_OPEN') => ({ window }) as never;
    expect(verdictForScorecard({ overnight, preOpen, scorecard: card('PRE_OPEN') })).toBe(preOpen);
    expect(verdictForScorecard({ overnight, preOpen, scorecard: card('OVERNIGHT') })).toBe(overnight);
    expect(verdictForScorecard({ overnight, preOpen: null, scorecard: card('PRE_OPEN') })).toBe(overnight);
  });
});

describe('news ideas', () => {
  it('badges CE / PE / No trade', () => {
    expect(ideaBadge('CE_IDEA')).toEqual({ label: 'CE idea', variant: 'success' });
    expect(ideaBadge('PE_IDEA')).toEqual({ label: 'PE idea', variant: 'danger' });
    expect(ideaBadge('NO_TRADE')).toEqual({ label: 'No trade', variant: 'neutral' });
  });

  it('judges the outcome against the idea direction once filled', () => {
    const filledAt = '2026-10-20T10:00:00Z';
    expect(ideaOutcome({ idea: 'CE_IDEA', moveBp: 214, filledAt })).toEqual({ label: 'Next session +2.14%', verdict: 'right' });
    expect(ideaOutcome({ idea: 'PE_IDEA', moveBp: 214, filledAt })?.verdict).toBe('wrong');
    expect(ideaOutcome({ idea: 'PE_IDEA', moveBp: -50, filledAt })?.verdict).toBe('right');
    expect(ideaOutcome({ idea: 'NO_TRADE', moveBp: -50, filledAt })?.verdict).toBe('none');
    expect(ideaOutcome({ idea: 'CE_IDEA', moveBp: 0, filledAt })?.verdict).toBe('flat');
    expect(ideaOutcome({ idea: 'CE_IDEA', moveBp: 120, filledAt: null })).toBeNull();
    expect(ideaOutcome({ idea: 'CE_IDEA' })).toBeNull();
  });

  it('builds a chart ref without a token and sorts newest first', () => {
    expect(ideaSymbolRef({ symbol: 'M&M', exchange: 'NSE' })).toEqual({
      symbol: 'M&M',
      exchange: 'NSE',
      token: null,
      chartHref: '/charts?symbol=M%26M&exchange=NSE',
    });
    const rows = [{ createdAt: '2026-10-19T18:00:00Z' }, { createdAt: 'bad' }, { createdAt: '2026-10-20T03:00:00Z' }];
    expect(sortIdeasNewestFirst(rows).map((r) => r.createdAt)).toEqual(['2026-10-20T03:00:00Z', '2026-10-19T18:00:00Z', 'bad']);
  });
});
