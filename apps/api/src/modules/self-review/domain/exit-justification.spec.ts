import type { AdverseProbability } from '../../exit-noise/domain/adverse-probability';
import { exitJustificationStats, judgeExit } from './exit-justification';
import { scoreLiveExit, type LiveExitRow } from './scorers';
import { adverseMoveFromBars, scorePaperExit, type PaperExitRow } from './learning-kinds';

const adv = (p: number | null): AdverseProbability => ({ p, basis: 'heuristic-v1', from: p === null ? 'none' : 'noise-read', parts: [{ name: 'MOVE', contribution: 0.5, read: p !== null, note: 'x' }] });

describe('the owner rule: a recovered exit is a miss only when not justified (p < 0.75)', () => {
  it('not justified and recovered → MISS', () => {
    expect(judgeExit(adv(0.6), true)).toMatchObject({ outcome: 'MISS', correct: false, justified: false, pAdverse: 0.6 });
  });
  it('justified (p ≥ 0.75) and recovered anyway → JUSTIFIED_UNLUCKY, not a miss', () => {
    expect(judgeExit(adv(0.75), true)).toMatchObject({ outcome: 'JUSTIFIED_UNLUCKY', correct: null, justified: true });
  });
  it('the exit held up → HELD_UP (right) whatever p says', () => {
    expect(judgeExit(adv(0.2), false)).toMatchObject({ outcome: 'HELD_UP', correct: true });
    expect(judgeExit(adv(0.9), false)).toMatchObject({ outcome: 'HELD_UP', correct: true, justified: true });
  });
  it('null p (nothing read) → not justified: counted as a miss as before, and says so', () => {
    const j = judgeExit(adv(null), true);
    expect(j).toMatchObject({ outcome: 'MISS', correct: false, justified: false, pAdverse: null });
    expect(j.note).toMatch(/no p .* counted as a miss as before/);
    expect(judgeExit(undefined, true).outcome).toBe('MISS');
  });
  it('unjudgeable stays unjudged', () => {
    expect(judgeExit(adv(0.9), null)).toMatchObject({ outcome: 'UNJUDGED', correct: null });
  });
});

const paper = (over: Partial<PaperExitRow> = {}): PaperExitRow => ({
  tradeId: 't1', sessionDate: '2026-10-30', symbol: 'SENSEX26N0574500CE', underlying: 'SENSEX', exitRule: 'AI_TRIGGER', exitAt: new Date('2026-10-30T05:55:00Z'),
  want: 'BULLISH', entryPrice: 539.75, exitPrice: 531.3, qty: 20, reason: 'AI trigger', n: 25, nSource: 'candles_1m', underlyingAtExit: 74458,
  after15m: null, after30m: null, maxFavour30m: 175, maxAgainst30m: 10, noiseVerdict: null, noiseSummary: null, held: null, ...over,
});

describe('PAPER_EXIT under the rule', () => {
  it('recovered + p < 0.75 → miss, with pAdverse / justified / outcome in details', () => {
    const d = scorePaperExit(paper({ adverse: adv(0.4) }));
    expect(d).toMatchObject({ correct: false, details: { pAdverse: 0.4, justified: false, outcome: 'MISS', justifiedP: 0.75, pBasis: 'heuristic-v1' } });
    expect(d.actual).toMatch(/^premature exit: .*; p 0.4$/);
  });
  it('recovered + p ≥ 0.75 → JUSTIFIED_UNLUCKY (correct null)', () => {
    const d = scorePaperExit(paper({ adverse: adv(0.8) }));
    expect(d).toMatchObject({ correct: null, details: { outcome: 'JUSTIFIED_UNLUCKY', justified: true } });
    expect(d.actual).toMatch(/^justified, unlucky \(p 0.8\): underlying 7 N in favour/);
  });
  it('no p → counted as before (miss), details say pFrom none', () => {
    expect(scorePaperExit(paper())).toMatchObject({ correct: false, details: { pAdverse: null, outcome: 'MISS', pFrom: 'none' } });
  });
  it('the candles_1m fallback move: best high since max(entry, exit − 120 min) to the exit close, in N', () => {
    const t0 = Date.parse('2026-10-30T05:00:00Z');
    const bars = Array.from({ length: 56 }, (_, k) => ({ ts: t0 + k * 60_000, open: 100, high: k === 30 ? 130 : 102, low: 98, close: 100 }));
    expect(adverseMoveFromBars(bars, new Date('2026-10-30T05:55:20Z'), 'BULLISH', 10)).toBe(3);
    expect(adverseMoveFromBars(bars, new Date('2026-10-30T05:55:20Z'), 'BULLISH', 10, new Date('2026-10-30T05:40:00Z'))).toBe(0.2);
    expect(adverseMoveFromBars(bars, new Date('2026-10-30T05:55:20Z'), 'BEARISH', 10)).toBe(0.2);
    expect(adverseMoveFromBars(bars, new Date('2026-10-30T05:55:20Z'), 'BULLISH', null)).toBeNull();
  });
});

const live = (over: Partial<LiveExitRow> = {}): LiveExitRow => ({
  executionId: 'e1', verdictId: 'v1', symbol: 'RELIANCE23NOV261300CE', positionSide: 'LONG', qty: 500, decisionPrice: 7.15,
  decisionAt: new Date('2026-11-02T04:18:00Z'), closeAt60: 9.65, closeAtEnd: 9.75, sessionDate: '2026-11-02', minutesSinceOpen: 33, ...over,
});

describe('LIVE_EXIT under the rule', () => {
  it('RELIANCE 1300 CE 11-02: the option was higher 60 min later → a miss when p < 0.75', () => {
    expect(scoreLiveExit(live({ adverse: adv(0.3) }))).toMatchObject({ correct: false, score: -1250, details: { outcome: 'MISS', pAdverse: 0.3 } });
  });
  it('… JUSTIFIED_UNLUCKY when p ≥ 0.75', () => {
    const d = scoreLiveExit(live({ adverse: adv(0.85) }));
    expect(d).toMatchObject({ correct: null, score: -1250, details: { outcome: 'JUSTIFIED_UNLUCKY', justified: true } });
    expect(d.actual).toMatch(/justified, unlucky \(p 0.85\)/);
  });
  it('a held-up exit is right; without p the old rule stands', () => {
    expect(scoreLiveExit(live({ closeAt60: 6, adverse: adv(0.3) }))).toMatchObject({ correct: true, details: { outcome: 'HELD_UP' } });
    expect(scoreLiveExit(live())).toMatchObject({ correct: false, details: { outcome: 'MISS', pAdverse: null } });
  });
});

describe('exitJustificationStats', () => {
  it('counts exits, justified, justified-but-recovered and misses per kind', () => {
    const rows = [
      scorePaperExit(paper({ adverse: adv(0.8) })),
      scorePaperExit(paper({ adverse: adv(0.4) })),
      scorePaperExit(paper()),
      scorePaperExit(paper({ maxFavour30m: 5, adverse: adv(0.9) })),
      scoreLiveExit(live({ adverse: adv(0.85) })),
      { kind: 'NEWS_IDEA' as const, details: {} },
    ];
    const s = exitJustificationStats(rows);
    expect(s).toMatchObject({ exits: 5, judged: 5, withP: 4, justified: 3, justifiedRecovered: 2, misses: 2, missesWithoutP: 1, threshold: 0.75, basis: ['heuristic-v1'] });
    expect(s.byKind.LIVE_EXIT).toMatchObject({ exits: 1, justified: 1, justifiedRecovered: 1, misses: 0 });
    expect(s.byKind.PAPER_EXIT).toMatchObject({ exits: 4, justified: 2, justifiedRecovered: 1, misses: 2 });
  });
});
