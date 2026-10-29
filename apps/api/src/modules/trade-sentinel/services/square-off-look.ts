import type { Segment } from '../charges';
import type { TripwireFire } from '../tripwires/types';
import {
  EXIT_CANDIDATE_VERDICTS,
  SQUARE_OFF_DUE,
  hardRiskWindow,
  hardRiskWindowMinutes,
  minutesToDeadline,
  type JudgeGateConfig,
} from './judge-gate';

/**
 * SQUARE-OFF LOOK — the one forced decision before an intraday position's deadline.
 *
 * Prod 2026-10-29: JPL-EQ (live MIS cash, NSE) was judged at 13:43 and 14:44,
 * both HOLD, and then never again until Angel squared it off at 15:15 (about
 * −₹2,400). The hard-risk window (judge-gate.ts) only lets an EXISTING wake past
 * the rate cap; it never creates one, and on a quiet tape no sensor fired. So
 * nothing asked "exit now, or let the broker close it?" before the broker did.
 *
 * The rule, pure and read entirely off the latest LIVE verdict row (so it is
 * durable across a restart and needs no memory of its own):
 *
 *  1. FIRST LOOK. The position is inside its hard-risk window (intraday cash:
 *     counted to the 15:15 MIS square-off; F&O: the session-close guard, or the
 *     expiry-day window; delivery never) and has NOT been judged since the
 *     window opened ⇒ one `square-off-due` fire. Once a verdict inside the window
 *     is recorded, it is never raised again that session — any judgement inside
 *     the window carries the same `squareOffDecision` framing, so it counts.
 *  2. ONE FINAL RE-LOOK (SENTINEL_SQUARE_OFF_RELOOK_MIN, default 5; 0 = off).
 *     When the in-window verdict was NOT an exit (EXIT_NOW / EXIT_ARMED), was made
 *     before the final `relookMin` minutes, and the deadline has not passed ⇒
 *     one more `square-off-due` fire in those final minutes. WHY ONE: the window
 *     opens 10 minutes out, and a HOLD then is a call on a price that can still
 *     move a long way for an intraday stock; the owner has to act by hand on
 *     cash, so a second, last call while there is still time is worth one more
 *     judgement. WHY NOT MORE: anything later than ~5 minutes out leaves no time
 *     to act on it, and repeated looks are the judge-every-30-s loop the gate
 *     exists to prevent. At most two judgements per position per session.
 *
 * The fire is a NEW-risk fire (futile-rejudge.ts NEW_RISK_FIRES), not a
 * suppressible repeat, and a named cap bypass — nothing on the wake path drops it
 * except the owner-hold gate (the owner said hands off) and the agent backoff.
 */

export interface SquareOffInput {
  cfg: Pick<
    JudgeGateConfig,
    'squareOffLook' | 'squareOffRelookMin' | 'closeGuardMin' | 'expiryCloseMin' | 'eqSquareOffLeadMin'
  >;
  segment: Segment;
  kind: 'POSITION' | 'HOLDING';
  exchange: string;
  /** Minutes to the EXCHANGE close, or null when the session is not open. */
  minutesToClose: number | null;
  expiryToday: boolean;
  nowMs: number;
  /** The latest live verdict, or null when never judged. */
  last: { verdict: string; createdAt: Date } | null;
}

/** The packet's deadline framing (ContextPacket.squareOffDecision). A `type` so it stays Prisma-JSON assignable. */
export type SquareOffDecision = {
  /** BROKER_SQUARE_OFF: the broker closes an intraday cash position at market. SESSION_CLOSE / EXPIRY_CLOSE: the exchange close. */
  deadline: 'BROKER_SQUARE_OFF' | 'SESSION_CLOSE' | 'EXPIRY_CLOSE';
  /** HH:MM IST of the deadline. */
  deadlineIst: string;
  /** Whole minutes left (0 once it has passed). */
  minutesLeft: number;
  /** FIRST: the window's first decision; FINAL: the last re-look; IN_WINDOW: any other judgement inside the window. */
  look: 'FIRST' | 'FINAL' | 'IN_WINDOW';
  /** The two options, in words. */
  choice: string;
};

export interface SquareOffLook {
  /** The forced wake, or null when this pass owes none. */
  fire: TripwireFire | null;
  /** The packet framing for any judgement made on this pass. */
  decision: SquareOffDecision;
  /** Minutes to the deadline (may be fractional or negative). */
  minutesLeft: number;
}

const hhmm = (ms: number): string => {
  const ist = new Date(ms + 5.5 * 3_600_000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
};

/** The deadline look for this pass, or null when the position is not inside its window (or the feature is off). */
export function squareOffLook(p: SquareOffInput): SquareOffLook | null {
  const { cfg } = p;
  if (!cfg.squareOffLook || p.kind === 'HOLDING' || p.segment === 'EQ_DELIVERY' || p.minutesToClose === null) return null;
  if (!hardRiskWindow(cfg, p.segment, p.minutesToClose, p.expiryToday)) return null;

  const left = minutesToDeadline(cfg, p.segment, p.minutesToClose);
  const windowMin = hardRiskWindowMinutes(cfg, p.expiryToday);
  // minutesToClose counts whole minutes from the current minute (session-clock.ts), so the
  // deadline and the window's opening sit on minute boundaries: at 15:05:40 with 25 left the
  // close is 15:30 and an MIS window opened at 15:05:00, not 15:05:40.
  const minuteMs = Math.floor(p.nowMs / 60_000) * 60_000;
  const deadlineMs = minuteMs + left * 60_000;
  const openedMs = deadlineMs - windowMin * 60_000;
  const relookMin = cfg.squareOffRelookMin;
  const relookOpensMs = deadlineMs - relookMin * 60_000;
  const lastMs = p.last ? p.last.createdAt.getTime() : null;
  const judgedInWindow = lastMs !== null && lastMs >= openedMs;

  let look: SquareOffDecision['look'] = 'IN_WINDOW';
  if (!judgedInWindow) look = 'FIRST';
  else if (
    relookMin > 0 &&
    relookMin < windowMin &&
    left > 0 &&
    p.nowMs >= relookOpensMs &&
    lastMs! < relookOpensMs &&
    !EXIT_CANDIDATE_VERDICTS.has(p.last!.verdict)
  ) {
    look = 'FINAL';
  }

  const cash = p.segment === 'EQ_INTRADAY';
  const deadline: SquareOffDecision['deadline'] = cash ? 'BROKER_SQUARE_OFF' : p.expiryToday ? 'EXPIRY_CLOSE' : 'SESSION_CLOSE';
  const mins = Math.max(0, Math.round(left));
  const at = hhmm(deadlineMs);
  const choice = cash
    ? `Decide now, ${mins} min before ${at} IST: EXIT_NOW exits at the current price; any other verdict lets the broker square this intraday (MIS) position off at market at ${at} IST, whatever the price is then. There is no later decision.`
    : `Decide now, ${mins} min before the ${String(p.exchange).toUpperCase()} close at ${at} IST: EXIT_NOW exits at the current price; any other verdict holds it through the close — an intraday (MIS) position is then squared off by the broker, a carry-forward one is held overnight with the gap risk${p.expiryToday ? '. This contract expires today' : ''}.`;

  const fire: TripwireFire | null =
    look === 'IN_WINDOW'
      ? null
      : {
          name: SQUARE_OFF_DUE,
          detail:
            `${look === 'FIRST' ? 'deadline look' : 'final look'}: ${mins} min to ` +
            `${cash ? 'the broker\'s MIS square-off' : p.expiryToday ? 'the expiry-day close' : 'the session close'} at ${at} IST — exit now, or let the deadline decide`,
        };
  return { fire, decision: { deadline, deadlineIst: at, minutesLeft: mins, look, choice }, minutesLeft: left };
}
