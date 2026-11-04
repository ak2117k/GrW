/**
 * Next-session scoring of a close decision — pure (spec 2026-11-04 §5.4; same shape as
 * ai_exit_outcomes' missed/saved). Both choices are scored against the same counterfactual:
 * what CARRYING would have made by 10:15 IST next session, measured from the decision price.
 *
 *  - gapPct      the next session's first print vs the decision price, % (signed price move)
 *  - maxAfter / minAfter  the first hour's high / low (bars starting before 10:15 IST)
 *  - priceAt1015 the close of the last bar starting before 10:15 IST
 *  - pnlCarry    side × (priceAt1015 − decisionPrice) × qty × value factor (gross rupees)
 *  - pnlExit     0 — exiting at the decision price ends the trade there
 *  - verdict     CARRY is RIGHT when pnlCarry ≥ 0; EXIT is RIGHT when pnlCarry < 0 (carrying lost)
 *  - edge        what the call made against the other choice: CARRY ⇒ pnlCarry, EXIT ⇒ −pnlCarry
 *
 * Gross on purpose: the charges of the two paths are close (an exit order either now or later) and
 * the question is the overnight gap. No bars in the first hour (expired contract, missing data) ⇒ null.
 */
export interface ScoreBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CarryScoreInput {
  decision: 'CARRY' | 'EXIT';
  side: 'LONG' | 'SHORT';
  qty: number;
  valueFactor: number;
  decisionPrice: number;
  /** The next session's 1-minute bars (any order). */
  bars: ReadonlyArray<ScoreBar>;
  /** 10:15 IST on the scoring day, epoch ms. */
  cutoffMs: number;
}

export interface CarryScore {
  gapPct: number;
  maxAfter: number;
  minAfter: number;
  priceAt1015: number;
  pnlCarry: number;
  pnlExit: number;
  verdict: 'RIGHT' | 'WRONG';
  edge: number;
  barsUsed: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function scoreCarryDecision(i: CarryScoreInput): CarryScore | null {
  if (!ok(i.decisionPrice) || !(Math.abs(i.qty) > 0)) return null;
  const bars = i.bars
    .filter((b) => b.ts < i.cutoffMs && ok(b.open) && ok(b.high) && ok(b.low) && ok(b.close))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (bars.length === 0) return null;
  const dir = i.side === 'LONG' ? 1 : -1;
  const vf = ok(i.valueFactor) ? i.valueFactor : 1;
  const priceAt1015 = bars[bars.length - 1].close;
  const pnlCarry = r2(dir * (priceAt1015 - i.decisionPrice) * Math.abs(i.qty) * vf);
  const right = i.decision === 'CARRY' ? pnlCarry >= 0 : pnlCarry < 0;
  return {
    gapPct: r2(((bars[0].open - i.decisionPrice) / i.decisionPrice) * 100),
    maxAfter: Math.max(...bars.map((b) => b.high)),
    minAfter: Math.min(...bars.map((b) => b.low)),
    priceAt1015,
    pnlCarry,
    pnlExit: 0,
    verdict: right ? 'RIGHT' : 'WRONG',
    edge: i.decision === 'CARRY' ? pnlCarry : r2(-pnlCarry),
    barsUsed: bars.length,
  };
}

/** The night-report / log line: "carry calls: n, right k, Δ₹x" over scored decisions. */
export function carryScorecardLine(rows: ReadonlyArray<{ decision: string; scoreVerdict: string | null; pnlCarry: number | null }>): string {
  const scored = rows.filter((r) => (r.decision === 'CARRY' || r.decision === 'EXIT') && r.scoreVerdict && r.pnlCarry !== null);
  const right = scored.filter((r) => r.scoreVerdict === 'RIGHT').length;
  const delta = scored.reduce((s, r) => s + (r.decision === 'CARRY' ? (r.pnlCarry as number) : -(r.pnlCarry as number)), 0);
  const carries = scored.filter((r) => r.decision === 'CARRY').length;
  return `carry calls: ${scored.length} (carried ${carries}, exited ${scored.length - carries}), right ${right}, Δ₹${Math.round(delta)}`;
}
