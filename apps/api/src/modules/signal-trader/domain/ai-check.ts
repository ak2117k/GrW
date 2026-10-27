/**
 * Was the AI judge right? (owner 2026-10-27, PAPER learning mode). Pure.
 *
 * Every call is paper-traded whatever the judge said, with no stop; when the trade closes (T1, the
 * close, the horizon rules) its result is held against the judge's own call: TAKE and it made money,
 * or SKIP and it did not → the AI was RIGHT; otherwise WRONG. A judge that never answered (NONE)
 * is not scored. The move is the contract's own price move (charges left out, so a flat trade is a
 * loss of the edge, not of money: SKIP is right on it).
 */
export type AiDecision = 'TAKE' | 'SKIP' | 'NONE';

export interface AiCheck {
  aiDecision: AiDecision;
  /** The move in the call's direction, % of entry. */
  movePct: number;
  /** ₹ (exit − entry) × qty × side. */
  pnl: number;
  exitTag: string;
  /** true = the AI was right, false = wrong, null = not scored (no verdict / no prices). */
  correct: boolean | null;
  at: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function aiDecisionOf(judgeRecord: unknown): AiDecision {
  const r = judgeRecord && typeof judgeRecord === 'object' && !Array.isArray(judgeRecord) ? (judgeRecord as Record<string, unknown>) : {};
  if (r.aiDecision === 'TAKE' || r.aiDecision === 'SKIP' || r.aiDecision === 'NONE') return r.aiDecision;
  return 'NONE';
}

export function aiCheck(i: { aiDecision: AiDecision; side: string; entry: number | null; exit: number | null; qty: number; exitTag: string; at: Date }): AiCheck {
  const sign = String(i.side).toUpperCase() === 'SELL' ? -1 : 1;
  const priced = i.entry !== null && i.entry > 0 && i.exit !== null && i.exit > 0;
  const move = priced ? (sign * ((i.exit as number) - (i.entry as number))) / (i.entry as number) : 0;
  const pnl = priced ? sign * ((i.exit as number) - (i.entry as number)) * i.qty : 0;
  const won = move > 0;
  const correct = !priced || i.aiDecision === 'NONE' ? null : i.aiDecision === 'TAKE' ? won : !won;
  return { aiDecision: i.aiDecision, movePct: r2(move * 100), pnl: r2(pnl), exitTag: i.exitTag, correct, at: i.at.toISOString() };
}

export interface AiScorecard {
  scored: number;
  right: number;
  wrong: number;
  /** right / scored, %, null below one scored trade. */
  accuracyPct: number | null;
  takeRight: number;
  takeWrong: number;
  skipRight: number;
  skipWrong: number;
  unscored: number;
}

/** Totals over stored checks (the feed's header and the self-review). */
export function aiScorecard(checks: ReadonlyArray<Pick<AiCheck, 'aiDecision' | 'correct'> | null>): AiScorecard {
  const s: AiScorecard = { scored: 0, right: 0, wrong: 0, accuracyPct: null, takeRight: 0, takeWrong: 0, skipRight: 0, skipWrong: 0, unscored: 0 };
  for (const c of checks) {
    if (!c || c.correct === null) {
      s.unscored++;
      continue;
    }
    s.scored++;
    if (c.correct) s.right++;
    else s.wrong++;
    if (c.aiDecision === 'TAKE') c.correct ? s.takeRight++ : s.takeWrong++;
    else c.correct ? s.skipRight++ : s.skipWrong++;
  }
  s.accuracyPct = s.scored > 0 ? Math.round((s.right / s.scored) * 100) : null;
  return s;
}
