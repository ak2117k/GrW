import { carryScorecardLine, scoreCarryDecision } from './carry-score';

const IST = 330 * 60_000;
const t = (hh: number, mm: number) => Date.parse(`2026-11-05T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`) - IST;
const bar = (hh: number, mm: number, o: number, h: number, l: number, c: number) => ({ ts: t(hh, mm), open: o, high: h, low: l, close: c });
const bars = [bar(9, 15, 110, 112, 104, 106), bar(9, 16, 106, 120, 105, 118), bar(10, 14, 118, 119, 116, 117), bar(10, 15, 117, 130, 117, 129)];
const base = { side: 'LONG' as const, qty: 75, valueFactor: 1, decisionPrice: 100, bars, cutoffMs: t(10, 15) };

describe('scoreCarryDecision — next-session first hour vs the decision price', () => {
  it('CARRY of a long that gapped up: gap, range, P&L at 10:15, RIGHT', () => {
    expect(scoreCarryDecision({ ...base, decision: 'CARRY' })).toMatchObject({
      gapPct: 10, maxAfter: 120, minAfter: 104, priceAt1015: 117, pnlCarry: 1275, pnlExit: 0, verdict: 'RIGHT', edge: 1275, barsUsed: 3,
    });
  });

  it('EXIT of the same: WRONG, edge negative; a short is mirrored', () => {
    expect(scoreCarryDecision({ ...base, decision: 'EXIT' })).toMatchObject({ verdict: 'WRONG', edge: -1275 });
    expect(scoreCarryDecision({ ...base, decision: 'EXIT', side: 'SHORT' })).toMatchObject({ pnlCarry: -1275, verdict: 'RIGHT' });
  });

  it('MCX value factor scales rupees; no bars or no price → null', () => {
    expect(scoreCarryDecision({ ...base, decision: 'CARRY', qty: 1, valueFactor: 100 })!.pnlCarry).toBe(1700);
    expect(scoreCarryDecision({ ...base, decision: 'CARRY', bars: [] })).toBeNull();
    expect(scoreCarryDecision({ ...base, decision: 'CARRY', decisionPrice: 0 })).toBeNull();
  });

  it('scorecard line: n, right k, Δ₹ (an EXIT counts the loss it saved)', () => {
    expect(
      carryScorecardLine([
        { decision: 'CARRY', scoreVerdict: 'RIGHT', pnlCarry: 500 },
        { decision: 'EXIT', scoreVerdict: 'RIGHT', pnlCarry: -300 },
        { decision: 'EXIT', scoreVerdict: 'WRONG', pnlCarry: 100 },
        { decision: 'NONE', scoreVerdict: null, pnlCarry: null },
      ]),
    ).toBe('carry calls: 3 (carried 1, exited 2), right 2, Δ₹700');
  });
});
