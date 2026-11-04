import { isIntradayProduct } from '../../trade-sentinel/services/judge-gate';
import type { CarryConfig } from './carry-config';
import type { ConversionCheck } from './verify-conversion';

/**
 * THE INTRADAY CLOSE DECISION — pure (spec 2026-11-04 §5.3, decisions D1–D7, D11–D13, D15).
 *
 * Every intraday (MIS) F&O position — manual or channel (signal-trader) — gets one decision before
 * the broker's MIS square-off: CARRY (convert MIS → carry-forward, hold overnight) or EXIT. The AI
 * judge makes the call (D2) on the forced close look (square-off-look.ts `carryLook`): HOLD is read
 * as CARRY, any other verdict (EXIT_NOW, EXIT_ARMED, ESCALATE) as EXIT. Its reason is the recorded
 * reason. Code only adds what no judge may override:
 *  - D6  a contract expiring today is EXITed, never carried;
 *  - D7  an AI_AUTO_EXIT_HOLD position: NOTHING (no conversion, no exit) — the hold wins and the
 *        broker squares it off if it is MIS; logged;
 *  - D13 a LIVE position of a user not in INTRADAY_CARRY_USERS: NOTHING (paper is simulated for all);
 *  - no judgement by DECIDE_BY_MIN before the square-off ⇒ EXIT (the silent-absence guard: the
 *    decision itself must never be what silently didn't happen);
 *  - D4  a CARRY the position book has not confirmed by SAFETY_MIN before the square-off ⇒ EXIT;
 *  - D11 an EXIT the AI_AUTO_EXIT_DAILY_CAP blocks ⇒ CAP_BLOCKED_BROKER_SQUARE_OFF (the cap is not
 *        bypassed; the broker's square-off is accepted). A CARRY still runs: a conversion is no exit.
 */

export type CloseAction = 'NONE' | 'WAIT' | 'CARRY' | 'EXIT' | 'CAP_BLOCKED_BROKER_SQUARE_OFF';

export interface CloseOutcome {
  action: CloseAction;
  reason: string;
}

export interface CloseFacts {
  mode: 'live' | 'paper';
  /** Live only: the user is in INTRADAY_CARRY_USERS (paper ignores it). */
  userAllowed: boolean;
  productType: string | null;
  expiryToday: boolean;
  /** AI_AUTO_EXIT_HOLD names this position. */
  held: boolean;
  /** Minutes to the broker's MIS square-off (may be fractional or negative). */
  minutesLeft: number;
  /** The latest judgement made inside the close window, or null. */
  verdict: { verdict: string; reason: string } | null;
  /** Live only: the AI auto-exit daily cap is used up today. */
  capExhausted: boolean;
}

const out = (action: CloseAction, reason: string): CloseOutcome => ({ action, reason: reason.slice(0, 500) });

/** An EXIT the cap would block becomes the accepted broker square-off (D11). Paper has no cap. */
function exitOrCap(f: Pick<CloseFacts, 'mode' | 'capExhausted'>, reason: string): CloseOutcome {
  if (f.mode === 'live' && f.capExhausted) {
    return out('CAP_BLOCKED_BROKER_SQUARE_OFF', `${reason} — but AI_AUTO_EXIT_DAILY_CAP is used up today: the broker squares it off`);
  }
  return out('EXIT', reason);
}

/** The judge's verdict as a close decision: HOLD = CARRY, anything else = EXIT. */
export const closeDecisionOf = (verdict: string): 'CARRY' | 'EXIT' => (String(verdict).toUpperCase() === 'HOLD' ? 'CARRY' : 'EXIT');

export function decideClose(f: CloseFacts, cfg: Pick<CarryConfig, 'decideByMin'>): CloseOutcome {
  if (!isIntradayProduct(f.productType)) return out('NONE', `product ${f.productType ?? 'unknown'} is not INTRADAY — no close decision`);
  if (f.mode === 'live' && !f.userAllowed) return out('NONE', 'NOT_ALLOWED_USER — not in INTRADAY_CARRY_USERS (paper-only)');
  if (f.held) return out('NONE', 'OWNER_HOLD — AI_AUTO_EXIT_HOLD names it: no conversion, no exit; the broker squares off an MIS position');
  if (f.minutesLeft <= 0) return out('NONE', 'PAST_DEADLINE — the broker square-off time has passed');
  if (f.expiryToday) return exitOrCap(f, 'EXPIRY_DAY — a contract expiring today is never carried');
  if (!f.verdict) {
    if (f.minutesLeft > cfg.decideByMin) return out('WAIT', 'waiting for the close judgement');
    return exitOrCap(f, `NO_JUDGEMENT — no close judgement ${cfg.decideByMin} min before the square-off`);
  }
  const d = closeDecisionOf(f.verdict.verdict);
  const why = `judge ${f.verdict.verdict}: ${f.verdict.reason}`;
  return d === 'CARRY' ? out('CARRY', why) : exitOrCap(f, why);
}

/** What to do after a conversion attempt, from a FRESH position book read (verify-conversion.ts). */
export type AfterConversion = 'DONE' | 'GONE' | 'RETRY' | 'RECHECK' | 'EXIT' | 'CAP_BLOCKED_BROKER_SQUARE_OFF';

/**
 * CONVERTED ⇒ DONE. POSITION_GONE ⇒ GONE (closed meanwhile; nothing to do). NOT_CONVERTED ⇒ one
 * retry of the conversion (`attempts` < 2), then re-check the book until SAFETY_MIN before the
 * square-off; at that point EXIT at market (D4) — or the cap's accepted broker square-off (D11).
 * A broker that answered "accepted" while the book still says MIS is NOT_CONVERTED (Review Focus 1).
 */
export function afterConversion(
  i: { check: ConversionCheck; minutesLeft: number; attempts: number; mode: 'live' | 'paper'; capExhausted: boolean },
  cfg: Pick<CarryConfig, 'safetyMin'>,
): AfterConversion {
  if (i.check === 'CONVERTED') return 'DONE';
  if (i.check === 'POSITION_GONE') return 'GONE';
  if (i.minutesLeft <= cfg.safetyMin) return i.mode === 'live' && i.capExhausted ? 'CAP_BLOCKED_BROKER_SQUARE_OFF' : 'EXIT';
  return i.attempts < 2 ? 'RETRY' : 'RECHECK';
}
