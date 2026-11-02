/**
 * Was the AI judge right? (owner 2026-10-27, PAPER learning mode). Pure.
 *
 * Every call is paper-traded whatever the judge said, with no stop; when the trade closes (T1, the
 * close, the horizon rules) its result is held against the judge's own call: TAKE and it made money,
 * or SKIP and it did not → the AI was RIGHT; otherwise WRONG. A judge that never answered (NONE)
 * is not scored. The move is the contract's own price move (charges left out, so a flat trade is a
 * loss of the edge, not of money: SKIP is right on it).
 *
 * That OLD rule (`correct`) is unfair to a SKIP: the learning trade has no stop, so a call the judge
 * could never have taken inside the risk cap still scores it "wrong" when it drifted into profit.
 * Since 2026-11-02 each check also carries `fair` (domain/fair-score: the cap-sized stop replayed on
 * the trade's price path); every reader goes through {@link aiVerdictOf}, which prefers it.
 */
import type { FairCheck, SkipKind } from './fair-score';

export type AiDecision = 'TAKE' | 'SKIP' | 'NONE';

export interface AiCheck {
  aiDecision: AiDecision;
  /** The move in the call's direction, % of entry. */
  movePct: number;
  /** ₹ (exit − entry) × qty × side. */
  pnl: number;
  exitTag: string;
  /**
   * The OLD rule (kept for compatibility): held against the no-stop learning trade. Superseded by
   * `fair` — read the verdict through aiVerdictOf, never this field alone.
   */
  correct: boolean | null;
  at: string;
  /** The FAIR verdict (domain/fair-score): the cap-sized stop replayed on the trade's price path. */
  fair?: FairCheck;
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

/**
 * The verdict to show / count: the FAIR one when the check carries it (UNSCORABLE ⇒ null — never a
 * fall back to the no-stop rule), else the old `correct` (checks written before 2026-11-02).
 */
export function aiVerdictOf(c: Pick<AiCheck, 'correct' | 'fair'> | null | undefined): { right: boolean | null; basis: 'fair' | 'old'; skipKind: SkipKind | null } {
  if (!c) return { right: null, basis: 'old', skipKind: null };
  if (c.fair && typeof c.fair === 'object' && typeof c.fair.verdict === 'string') {
    const v = c.fair.verdict;
    return { right: v === 'RIGHT' ? true : v === 'WRONG' ? false : null, basis: 'fair', skipKind: c.fair.skipKind ?? null };
  }
  return { right: c.correct, basis: 'old', skipKind: null };
}

export interface AiScorecard {
  /** Counted on aiVerdictOf: the fair verdict, the old rule only for checks without one (`oldBasis`). */
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
  /** SKIPs split by why the judge skipped (fair checks only). */
  skipRightRiskCap: number;
  skipWrongRiskCap: number;
  skipRightJudgement: number;
  skipWrongJudgement: number;
  /** Scored checks that had no fair block (pre-2026-11-02) and were counted on the old rule. */
  oldBasis: number;
  /** The OLD no-stop rule over the same checks, for comparison. */
  old: { scored: number; right: number; wrong: number; accuracyPct: number | null };
}

/** Totals over stored checks (the feed's header). */
export function aiScorecard(checks: ReadonlyArray<Pick<AiCheck, 'aiDecision' | 'correct' | 'fair'> | null>): AiScorecard {
  const s: AiScorecard = {
    scored: 0, right: 0, wrong: 0, accuracyPct: null, takeRight: 0, takeWrong: 0, skipRight: 0, skipWrong: 0, unscored: 0,
    skipRightRiskCap: 0, skipWrongRiskCap: 0, skipRightJudgement: 0, skipWrongJudgement: 0, oldBasis: 0,
    old: { scored: 0, right: 0, wrong: 0, accuracyPct: null },
  };
  for (const c of checks) {
    if (c && c.correct !== null && c.aiDecision !== 'NONE') {
      s.old.scored++;
      if (c.correct) s.old.right++;
      else s.old.wrong++;
    }
    const v = aiVerdictOf(c);
    if (!c || v.right === null || c.aiDecision === 'NONE') {
      s.unscored++;
      continue;
    }
    s.scored++;
    if (v.basis === 'old') s.oldBasis++;
    if (v.right) s.right++;
    else s.wrong++;
    if (c.aiDecision === 'TAKE') v.right ? s.takeRight++ : s.takeWrong++;
    else {
      v.right ? s.skipRight++ : s.skipWrong++;
      if (v.skipKind === 'RISK_CAP') v.right ? s.skipRightRiskCap++ : s.skipWrongRiskCap++;
      else if (v.skipKind === 'JUDGEMENT') v.right ? s.skipRightJudgement++ : s.skipWrongJudgement++;
    }
  }
  s.accuracyPct = s.scored > 0 ? Math.round((s.right / s.scored) * 100) : null;
  s.old.accuracyPct = s.old.scored > 0 ? Math.round((s.old.right / s.old.scored) * 100) : null;
  return s;
}
