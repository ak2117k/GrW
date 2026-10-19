import type { TripwireResult } from './tripwire.service';
import type { TripwireFire } from '../tripwires/types';
import { withExitConfirm } from '../tripwires/exit-confirm';

/**
 * FUTILE RE-JUDGE SUPPRESSION — a cost control on judgements whose answer
 * cannot change anything.
 *
 * Prod 2026-10-19: the AI exit executor failed every exit all day, and the
 * sentinel kept asking the judge about the same 7 positions — 552 verdicts,
 * 235 on one position, nearly all EXIT_NOW that nothing could carry out. The
 * re-judge suppression (rejudge-suppression.ts) only drops unchanged
 * giveback / volume repeats; exit-confirm re-looks and price moves still woke
 * the judge on a position whose exit could not run.
 *
 * Two rules, both acting on the FINAL wake (sensor fires + carried fires + the
 * exit-confirm re-look):
 *
 *  1. HELD. The owner holds the position against the AI (`AI_AUTO_EXIT_HOLD`,
 *     by trading symbol or tracker id — the executor's OWNER_HOLD guard). An
 *     EXIT_NOW would only be skipped, so FIRE-triggered judgements are dropped.
 *     The heartbeat is kept at its normal cadence, so the owner's dashboard
 *     still gets a periodic verdict. Logged once per position per 30 min.
 *
 *  2. EXIT BLOCKED. The latest exit attempt for the tracker (one
 *     `ai_exit_executions` read per cycle for all open trackers) ended FAILED
 *     with BROKER_AUTH / BROKER_READ, or SKIPPED with OWNER_HOLD, within the
 *     last `cooldownMs`. Another EXIT verdict would hit the same wall, so fires
 *     and the exit-confirm re-look are dropped (heartbeat kept) until the
 *     cooldown passes, a newer attempt supersedes it, or the position's quantity
 *     changes from what it was when that attempt was first seen.
 *
 * What it can NEVER suppress: a wake carrying a fire from a sensor that signals
 * NEW risk — `level-break`, `news-hit`, `event-near`, `oi-wall-shift`. Such a
 * wake passes through whole (every other fire included as context), held
 * position or not. Hard exits are not on this path at all: they live in the
 * exit-discipline gate and the executor, which this never touches.
 *
 * Fails OPEN: an unreadable executions table means no exit-blocked suppression
 * this cycle. The qty baseline is in-process memory; a restart forgets it,
 * which re-baselines to the current quantity — the attempt still suppresses
 * only within its cooldown. Rollback: SENTINEL_FUTILE_REJUDGE_SUPPRESSION=false
 * (behaviour identical to before this rule).
 */

export const FUTILE_REJUDGE_CONFIG = 'FUTILE_REJUDGE_CONFIG';
export const EXIT_ATTEMPTS = 'EXIT_ATTEMPTS';

/** Sensor families that assert NEW risk: a wake carrying any of these always reaches the judge. */
export const NEW_RISK_FIRES: ReadonlySet<string> = new Set(['level-break', 'news-hit', 'event-near', 'oi-wall-shift']);

/** How often the held-position line is logged per position. */
export const HELD_LOG_EVERY_MS = 30 * 60_000;

export interface FutileRejudgeConfig {
  /** SENTINEL_FUTILE_REJUDGE_SUPPRESSION — default true; rollback is `false`. */
  enabled: boolean;
  /** SENTINEL_FUTILE_REJUDGE_COOLDOWN_MIN (default 15): how long a blocked exit attempt suppresses EXIT re-judgements. */
  cooldownMs: number;
  /** AI_AUTO_EXIT_HOLD, parsed exactly as the executor parses it: upper-cased symbols / tracker ids. */
  hold: string[];
}

type Env = Record<string, string | undefined>;

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseFutileRejudgeConfig(env: Env): FutileRejudgeConfig {
  return {
    enabled: (env.SENTINEL_FUTILE_REJUDGE_SUPPRESSION ?? '').trim().toLowerCase() !== 'false',
    cooldownMs: positive(env.SENTINEL_FUTILE_REJUDGE_COOLDOWN_MIN, 15) * 60_000,
    // Same rule as sentinel-executor/domain/auto-exit.config.ts, so "held" means
    // the same thing here as in the executor's OWNER_HOLD guard.
    hold: [
      ...new Set(
        String(env.AI_AUTO_EXIT_HOLD ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    ],
  };
}

/** Same match as the executor's `isHeld`: by trading symbol or tracker id, case-insensitive. */
export function isHeldPosition(hold: readonly string[], p: { trackerId: string; symbol: string }): boolean {
  if (hold.length === 0) return false;
  return [p.symbol, p.trackerId]
    .map((k) => String(k ?? '').trim().toUpperCase())
    .filter(Boolean)
    .some((k) => hold.includes(k));
}

/** The latest `ai_exit_executions` row for a tracker. */
export interface ExitAttempt {
  id: string;
  trackerId: string;
  status: string;
  reason: string | null;
  createdAt: Date;
}

/** Read port: the latest exit attempt per tracker since `since`, in ONE query. */
export interface ExitAttemptReader {
  latestSince(userIds: string[], trackerIds: string[], since: Date): Promise<Map<string, ExitAttempt>>;
}

/** An attempt that shows another EXIT verdict cannot be carried out right now. */
export function isBlockingAttempt(a: Pick<ExitAttempt, 'status' | 'reason'>): boolean {
  if (a.status === 'FAILED') return a.reason === 'BROKER_AUTH' || a.reason === 'BROKER_READ';
  if (a.status === 'SKIPPED') return a.reason === 'OWNER_HOLD';
  return false;
}

/** In-process memory: the blocking attempt last seen, and the position quantity when it was first seen. */
export interface BlockedExitMemo {
  attemptId: string;
  qty: number;
}

/**
 * Whether EXIT re-judgements are futile for this tracker right now, and the memo
 * to keep. Lifts on: no attempt, a non-blocking latest attempt, cooldown passed,
 * or a quantity change since the attempt was first seen.
 */
export function exitBlocked(
  attempt: ExitAttempt | undefined,
  memo: BlockedExitMemo | undefined,
  qty: number,
  now: number,
  cfg: FutileRejudgeConfig,
): { blocked: boolean; memo: BlockedExitMemo | undefined } {
  if (!attempt || !isBlockingAttempt(attempt)) return { blocked: false, memo: undefined };
  if (now - attempt.createdAt.getTime() >= cfg.cooldownMs) return { blocked: false, memo: undefined };
  const kept = memo && memo.attemptId === attempt.id ? memo : { attemptId: attempt.id, qty };
  return { blocked: kept.qty === qty, memo: kept };
}

export type FutileCause = 'held' | 'exit-blocked';

/**
 * Apply the rules to a wake. `decision` is the sensor decision with carried
 * fires merged; `confirm` is the exit-confirm re-look (or null). Without a cause,
 * or with a NEW-risk fire present, the result is exactly
 * `withExitConfirm(decision, confirm)` — today's wake.
 *
 * When the fires are dropped the wake becomes the heartbeat's. A sensor fire
 * makes the tripwire skip its heartbeat computation, so `heartbeatDue` (asked
 * only then) supplies the normal-cadence answer.
 */
export function suppressFutileJudgements(
  decision: TripwireResult,
  confirm: TripwireFire | null,
  cause: FutileCause | null,
  cfg: FutileRejudgeConfig | undefined,
  heartbeatDue: () => boolean,
): { decision: TripwireResult; suppressed: string[] } {
  const whole = { decision: withExitConfirm(decision, confirm), suppressed: [] as string[] };
  if (!cfg?.enabled || cause === null) return whole;
  const fires = confirm && !decision.fires.some((f) => f.name === confirm.name) ? [...decision.fires, confirm] : decision.fires;
  if (fires.length === 0) return whole;
  if (fires.some((f) => NEW_RISK_FIRES.has(f.name))) return whole;
  const heartbeat = decision.heartbeat || heartbeatDue();
  return {
    decision: {
      fires: [],
      heartbeat,
      shouldEvaluate: heartbeat,
      trigger: heartbeat ? 'HEARTBEAT' : null,
    },
    suppressed: fires.map((f) => f.name),
  };
}
