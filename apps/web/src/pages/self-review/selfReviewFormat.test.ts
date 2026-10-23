import { describe, expect, it } from 'vitest';
import type { AgentLesson, SelfReviewSummary } from '@/types/selfReview.types';
import {
  formatValue,
  hitLine,
  hitRateOf,
  hitTone,
  kindLabel,
  kindRows,
  skillLines,
  signalTradeLines,
  lessonInjected,
  lessonsAddedCount,
  lessonsAddedList,
  pct,
  pendingBadge,
  sessionLabel,
  sortLessons,
  targetLabel,
  topMisses,
  totals,
} from './selfReviewFormat';

const summary: SelfReviewSummary = {
  session: '2026-10-20',
  byKind: {
    MBM_PREDICTION: { n: 10, right: 6, wrong: 4, nullCount: 0, hitRate: 0.6 },
    SCORECARD_FACTOR: { n: 40, right: 10, wrong: 20, nullCount: 10, hitRate: null },
    SCORECARD_TOTAL: { n: 5, right: 3, wrong: 1, nullCount: 1, hitRate: 0.75 },
    NEWS_IDEA: { n: 0, right: 0, wrong: 0, nullCount: 0, hitRate: null },
    CUSTOM_THING: { n: 2, right: 1, wrong: 1, nullCount: 0, hitRate: 0.5 },
  },
};

describe('hit rates', () => {
  it('pct rounds and dashes missing', () => {
    expect(pct(0.625)).toBe('63%');
    expect(pct(null)).toBe('—');
    expect(pct(Number.NaN)).toBe('—');
  });
  it('hitRateOf prefers the API value, else right/(right+wrong)', () => {
    expect(hitRateOf({ right: 1, wrong: 1, hitRate: 0.9 })).toBe(0.9);
    expect(hitRateOf({ right: 3, wrong: 1, hitRate: null })).toBe(0.75);
    expect(hitRateOf({ right: 0, wrong: 0 })).toBeNull();
  });
  it('hitLine mentions unjudged calls only when present', () => {
    expect(hitLine({ n: 5, right: 3, wrong: 1, nullCount: 1, hitRate: 0.75 })).toBe('75% · 3 right / 1 wrong · 1 not judged');
    expect(hitLine({ n: 4, right: 3, wrong: 1, nullCount: 0, hitRate: null })).toBe('75% · 3 right / 1 wrong');
  });
  it('hitTone thresholds', () => {
    expect(hitTone(0.6)).toBe('good');
    expect(hitTone(0.5)).toBe('neutral');
    expect(hitTone(0.4)).toBe('bad');
    expect(hitTone(null)).toBe('neutral');
  });
});

describe('kindRows / totals', () => {
  it('orders known kinds first, unknown after, drops empty kinds', () => {
    expect(kindRows(summary).map((r) => r.kind)).toEqual(['SCORECARD_TOTAL', 'MBM_PREDICTION', 'SCORECARD_FACTOR', 'CUSTOM_THING']);
    expect(kindRows(summary)[0].label).toBe('Scorecard calls');
    expect(kindLabel('STOCK_MOVE')).toBe('Stock big-move model');
    expect(kindLabel('MBM_RELATIVE')).toBe('Move size vs recent days');
    expect(kindRows(summary)[3].label).toBe('Custom thing');
  });
  it('is empty for a missing summary', () => {
    expect(kindRows(null)).toEqual([]);
    expect(kindRows({ session: 'x', byKind: undefined as never })).toEqual([]);
  });
  it('totals exclude per-factor rows', () => {
    expect(totals(summary)).toEqual({ right: 10, wrong: 6, rate: 10 / 16 });
    expect(totals(null).rate).toBeNull();
  });
});

describe('misses and lessons added', () => {
  it('topMisses keeps the first three with a cause', () => {
    const m = [
      { refIds: ['a'], cause: 'one' },
      { refIds: ['b'], cause: '  ' },
      { refIds: ['c'], cause: 'two' },
      { refIds: ['d'], cause: 'three' },
      { refIds: ['e'], cause: 'four' },
    ];
    expect(topMisses(m).map((x) => x.cause)).toEqual(['one', 'two', 'three']);
    expect(topMisses(undefined)).toEqual([]);
  });
  it('lessonsAdded accepts a count, keys or objects', () => {
    expect(lessonsAddedCount(3)).toBe(3);
    expect(lessonsAddedCount(['a', 'b'])).toBe(2);
    expect(lessonsAddedCount(undefined)).toBe(0);
    expect(lessonsAddedList(3)).toEqual([]);
    expect(lessonsAddedList(['k1'])).toEqual([{ key: 'k1', text: null }]);
    expect(
      lessonsAddedList([
        { id: '1', key: 'k2', text: 'Do X', scope: 'ALL', rightCount: 0, wrongCount: 0, status: 'ACTIVE', firstSeen: '', lastSeen: '' },
      ]),
    ).toEqual([{ key: 'k2', text: 'Do X' }]);
  });
});

describe('proposal values', () => {
  it('labels allow-listed targets', () => {
    expect(targetLabel('scorecard.factor.news.weight')).toBe('News factor weight');
    expect(targetLabel('scorecard.factor.oi.weight')).toBe('Option chain (OI) factor weight');
    expect(targetLabel('scorecard.factor.news.requireConfirmation')).toBe('News factor needs confirmation');
    expect(targetLabel('exit.openingGuardMin')).toBe('Exit opening guard (minutes)');
    expect(targetLabel('scorecard.stockMove.points')).toBe('Stock big-move model points (0 = shadow, 1 = counted)');
    expect(targetLabel('something.else')).toBe('something.else');
  });
  it('formats numbers, booleans, wrapped and raw JSON', () => {
    expect(formatValue(1)).toBe('1');
    expect(formatValue(0.6250001)).toBe('0.625');
    expect(formatValue(true)).toBe('On');
    expect(formatValue(false)).toBe('Off');
    expect(formatValue(null)).toBe('—');
    expect(formatValue({ value: 0.5 })).toBe('0.5');
    expect(formatValue([1, 2])).toBe('[1,2]');
  });
});

describe('lessons', () => {
  const l = (id: string, status: string, r: number, w: number): AgentLesson => ({
    id,
    key: id,
    text: id,
    scope: 'ALL',
    rightCount: r,
    wrongCount: w,
    status,
    firstSeen: '',
    lastSeen: '',
  });
  it('sorts active first, then by net right − wrong', () => {
    const sorted = sortLessons([l('a', 'RETIRED', 9, 0), l('b', 'ACTIVE', 1, 0), l('c', 'ACTIVE', 5, 1)]);
    expect(sorted.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
  it('is fed to the agent only when ACTIVE with ≥ 2 right', () => {
    expect(lessonInjected(l('a', 'ACTIVE', 2, 0))).toBe(true);
    expect(lessonInjected(l('a', 'ACTIVE', 1, 0))).toBe(false);
    expect(lessonInjected(l('a', 'RETIRED', 5, 0))).toBe(false);
  });
});

describe('misc', () => {
  it('sessionLabel', () => {
    expect(sessionLabel('2026-10-20')).toBe('20 Oct 2026');
    expect(sessionLabel(null)).toBe('—');
    expect(sessionLabel('weird')).toBe('weird');
  });
  it('pendingBadge', () => {
    expect(pendingBadge(0)).toBe('');
    expect(pendingBadge(undefined)).toBe('');
    expect(pendingBadge(3)).toBe('3');
    expect(pendingBadge(12)).toBe('9+');
  });
});

describe('skillLines', () => {
  const stats = (verdict: 'NOT_TESTABLE' | 'EDGE' | 'NO_EDGE', note: string) => ({
    n: 79, positives: 78, baseRate: 0.987, hitRate: 0.987, majorityHitRate: 0.987, auc: null,
    brier: 0.01, brierBaseline: 0.013, brierSkill: 0.2, verdict, note,
  });

  it('shows the 20-session verdict in words, with a neutral tone when not testable', () => {
    const s = { session: '2026-10-22', byKind: {}, skill: { MBM_PREDICTION: { session: stats('NOT_TESTABLE', 'x'), rolling20: stats('NOT_TESTABLE', 'only 1 small window(s) of 79') } } } as SelfReviewSummary;
    expect(skillLines(s)).toEqual([{ kind: 'MBM_PREDICTION', label: 'Move-size model', verdict: 'not testable yet', tone: 'neutral', note: 'only 1 small window(s) of 79' }]);
  });

  it('maps EDGE / NO_EDGE to good / bad and is empty for older runs without skill', () => {
    const mk = (v: 'EDGE' | 'NO_EDGE') => ({ session: '', byKind: {}, skill: { MBM_PREDICTION: { session: stats(v, ''), rolling20: stats(v, '') } } }) as SelfReviewSummary;
    expect(skillLines(mk('EDGE'))[0].tone).toBe('good');
    expect(skillLines(mk('NO_EDGE'))[0].tone).toBe('bad');
    expect(skillLines({ session: '', byKind: {} })).toEqual([]);
    expect(skillLines(null)).toEqual([]);
  });
});

describe('signalTradeLines', () => {
  it('live vs paper (no funds), last 20 sessions', () => {
    const o = (pnl: number, wins: number, losses: number, open = 0) => ({ n: wins + losses + open, open, closed: wins + losses, wins, losses, noTrade: 0, pnl, realised: pnl, winRate: null });
    const s: SelfReviewSummary = {
      session: '2026-10-23',
      byKind: {},
      signalTrades: { session: { live: o(0, 0, 0), paperNoFunds: o(0, 0, 0) }, rolling20: { live: o(-500, 0, 1), paperNoFunds: o(2775, 1, 0, 1) } },
    };
    expect(signalTradeLines(s)).toEqual([
      { key: 'live', label: 'Telegram signals — live', text: '1 closed · 0W/1L · P&L −₹500', tone: 'bad' },
      { key: 'paperNoFunds', label: 'Telegram signals — paper (no funds)', text: '1 closed · 1W/0L · 1 open · P&L ₹2,775', tone: 'good' },
    ]);
    expect(signalTradeLines({ session: '', byKind: {} })).toEqual([]);
  });
});
