import type { TripwireFire } from '../tripwires/types';
import type { TripwireResult } from './tripwire.service';

/**
 * JUDGE GATE — the last cost control before a judgement is dispatched
 * (owner-approved 2026-10-22). It acts on the FINAL wake: sensor fires after the
 * material-change gate (rejudge-suppression.ts), carried fires, the exit-confirm
 * re-look and the futile-re-judge rule.
 *
 * Prod 2026-10-21: ~966 verdicts over 11 positions (~88 per position per day),
 * 92 % of them identical to the verdict before; RELIANCE27OCT261270CE, on the
 * owner's hold list, alone produced 308 EXIT_NOWs that the executor then skipped.
 *
 * Three rules:
 *
 *  1. HELD (AI_AUTO_EXIT_HOLD, matched exactly like the executor's OWNER_HOLD
 *     guard). No sensor-driven judgement at all — not even a new-risk fire — and
 *     the heartbeat at most once per `heldHeartbeatMs` (default 30 min). The
 *     packet carries `ownerHold: true`, so the judge knows the answer is
 *     informational. Nothing here can exit anything; the executor's OWNER_HOLD
 *     skip is untouched.
 *
 *  2. RATE CAP. At most one judgement per position per `minIntervalMs`
 *     (SENTINEL_MIN_JUDGE_INTERVAL_SEC, default 900 s), measured from the latest
 *     LIVE verdict row (durable: survives a restart). Bypassed — safety beats
 *     savings — by: the first look at a position; the exit-confirm re-look (exit
 *     discipline §7 needs a second EXIT_NOW within PERSIST_WINDOW_SEC for
 *     CONSECUTIVE, or after PERSIST_MIN_SEC for SUSTAINED — so the confirmation
 *     path is never delayed); a latest verdict of EXIT_NOW or EXIT_ARMED (an exit
 *     candidate); a hard-risk window the cycle can see (intraday close, expiry-day
 *     close); an armed floor breached by ltp; the price beyond the latest
 *     verdict's exitTrigger; an adverse move of `adverseMovePct` while losing.
 *     A capped wake's EDGE-triggered fires (news-hit, event-near — spent once
 *     fired) and any already-carried fire are carried to the next judgement, so
 *     a capped headline is delayed, never lost.
 *
 *  3. TIER. A routine (HEARTBEAT-tier) wake on an exit candidate or under any of
 *     the risk bypasses above is upgraded to the strong (FIRE) tier. The cheap
 *     tier is only for "nothing material changed".
 *
 * Absent config ⇒ off: the cycle behaves exactly as before. Rollback:
 * SENTINEL_JUDGE_GATE=false.
 */

export const JUDGE_GATE_CONFIG = 'JUDGE_GATE_CONFIG';

export interface JudgeGateConfig {
  /** SENTINEL_JUDGE_GATE — default true; rollback is `false`. */
  enabled: boolean;
  /** SENTINEL_MIN_JUDGE_INTERVAL_SEC (default 900): at most one judgement per position per this long. */
  minIntervalMs: number;
  /** SENTINEL_HELD_HEARTBEAT_MIN (default 30): a held position's heartbeat at most this often. */
  heldHeartbeatMs: number;
  /** AI_AUTO_EXIT_HOLD, parsed exactly as the executor parses it. */
  hold: string[];
  /** SENTINEL_HARD_RISK_CLOSE_MIN (default 10, = exit discipline's GATE_CLOSE_MIN): the close window that bypasses the cap. */
  closeGuardMin: number;
  /** Minutes before the close on expiry day that bypass the cap (exit discipline's EXPIRY_CLOSE_MIN). */
  expiryCloseMin: number;
  /** SENTINEL_ADVERSE_MOVE_PCT (default 0.04): an adverse contract move, since the last judgement, that bypasses the cap while losing. */
  adverseMovePct: number;
  /** SENTINEL_PACKET_DELTA (default true): the `sinceLastVerdict` block on re-judgements. */
  packetDelta: boolean;
}

type Env = Record<string, string | undefined>;

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const isOff = (raw: string | undefined) => (raw ?? '').trim().toLowerCase() === 'false';

export function parseJudgeGateConfig(env: Env): JudgeGateConfig {
  return {
    enabled: !isOff(env.SENTINEL_JUDGE_GATE),
    // 0 is a legitimate "no cap" (the bypasses then never matter).
    minIntervalMs: nonNegative(env.SENTINEL_MIN_JUDGE_INTERVAL_SEC, 900) * 1000,
    heldHeartbeatMs: positive(env.SENTINEL_HELD_HEARTBEAT_MIN, 30) * 60_000,
    hold: [
      ...new Set(
        String(env.AI_AUTO_EXIT_HOLD ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    ],
    // Defaults to the exit gate's own HARD_SESSION_CLOSE window (GATE_CLOSE_MIN, default 10).
    closeGuardMin: nonNegative(env.SENTINEL_HARD_RISK_CLOSE_MIN, nonNegative(env.GATE_CLOSE_MIN, 10)),
    expiryCloseMin: 30,
    adverseMovePct: positive(env.SENTINEL_ADVERSE_MOVE_PCT, 0.04),
    packetDelta: !isOff(env.SENTINEL_PACKET_DELTA),
  };
}

/** Verdicts whose position is an exit candidate: the cap never delays its next look. */
export const EXIT_CANDIDATE_VERDICTS: ReadonlySet<string> = new Set(['EXIT_NOW', 'EXIT_ARMED']);

/** Edge-triggered sensors whose fire is spent once raised: carried when capped, never dropped. */
export const CARRY_WHEN_CAPPED: ReadonlySet<string> = new Set(['news-hit', 'event-near']);

export type CapBypass =
  | 'first-look'
  | 'exit-confirm'
  | 'exit-candidate'
  | 'hard-risk'
  | 'floor-breach'
  | 'trigger-crossed'
  | 'adverse-move';

/** What the gate needs to know about this position on this pass. */
export interface GateFacts {
  nowMs: number;
  /** The latest LIVE verdict, or null when the position was never judged. */
  last: { verdict: string; createdAt: Date } | null;
  held: boolean;
  hardRisk: boolean;
  floorBreached: boolean;
  triggerCrossed: boolean;
  adverseMove: boolean;
  /** Names of fires that were carried into this decision (they never reached the judge). */
  carried: ReadonlySet<string>;
}

export interface GateOutcome {
  decision: TripwireResult;
  /** Why the wake was dropped, or null when it passes. */
  dropped: 'held' | 'cap' | null;
  /** Fire names dropped ('heartbeat' for a dropped heartbeat). */
  suppressed: string[];
  /** Fires to keep carried for the next judgement (meaningful only when dropped). */
  carry: TripwireFire[];
  /** Why the cap did not apply, when it would have. */
  bypass: CapBypass | null;
  /** A routine wake raised to the strong tier. */
  upgraded: boolean;
}

const NONE: TripwireResult = { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null };

/** The cap bypass for this wake, if any — first match wins (reported only). */
export function capBypass(decision: TripwireResult, f: GateFacts): CapBypass | null {
  if (!f.last) return 'first-look';
  if (decision.fires.some((x) => x.name === 'exit-confirm')) return 'exit-confirm';
  if (f.hardRisk) return 'hard-risk';
  if (f.floorBreached) return 'floor-breach';
  if (f.triggerCrossed) return 'trigger-crossed';
  if (f.adverseMove) return 'adverse-move';
  if (EXIT_CANDIDATE_VERDICTS.has(f.last.verdict)) return 'exit-candidate';
  return null;
}

/**
 * Apply the three rules. `heartbeatDue` answers the normal-cadence heartbeat
 * question (a sensor fire makes the tripwire skip it, so it is asked only then).
 * Pure apart from calling it.
 */
export function gateJudgement(
  decision: TripwireResult,
  f: GateFacts,
  cfg: JudgeGateConfig | undefined,
  heartbeatDue: () => boolean,
): GateOutcome {
  const pass: GateOutcome = { decision, dropped: null, suppressed: [], carry: [], bypass: null, upgraded: false };
  if (!cfg?.enabled) return pass;
  const sinceMs = f.last ? f.nowMs - f.last.createdAt.getTime() : Number.POSITIVE_INFINITY;

  if (f.held) {
    const due = decision.heartbeat || (decision.fires.length > 0 && heartbeatDue());
    const heartbeat = due && sinceMs >= cfg.heldHeartbeatMs;
    const out: TripwireResult = heartbeat ? { fires: [], heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' } : NONE;
    const suppressed = decision.fires.map((x) => x.name);
    if (decision.shouldEvaluate && !heartbeat && suppressed.length === 0) suppressed.push('heartbeat');
    return { ...pass, decision: out, dropped: suppressed.length > 0 ? 'held' : null, suppressed };
  }

  if (!decision.shouldEvaluate) return pass;

  const bypass = capBypass(decision, f);
  if (bypass === null && sinceMs < cfg.minIntervalMs) {
    return {
      ...pass,
      decision: NONE,
      dropped: 'cap',
      suppressed: decision.fires.length > 0 ? decision.fires.map((x) => x.name) : ['heartbeat'],
      carry: decision.fires.filter((x) => CARRY_WHEN_CAPPED.has(x.name) || f.carried.has(x.name)),
    };
  }

  const risky =
    f.hardRisk || f.floorBreached || f.triggerCrossed || f.adverseMove || (f.last !== null && EXIT_CANDIDATE_VERDICTS.has(f.last.verdict));
  if (decision.trigger === 'HEARTBEAT' && risky) {
    return { ...pass, decision: { ...decision, trigger: 'FIRE' }, bypass, upgraded: true };
  }
  return { ...pass, bypass };
}

/** A stored exitTrigger (sentinel_verdicts.exitTrigger, StoredExitTriggerV1) the price is beyond now. Never throws. */
export function exitTriggerCrossed(
  stored: unknown,
  px: { ltp: number; underlyingLtp: number | null },
): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const t = stored as { instrument?: unknown; op?: unknown; price?: unknown };
  if (typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price <= 0) return false;
  const p = t.instrument === 'UNDERLYING' ? px.underlyingLtp : t.instrument === 'PREMIUM' ? px.ltp : null;
  if (p === null || !Number.isFinite(p)) return false;
  if (t.op === 'BELOW') return p < t.price;
  if (t.op === 'ABOVE') return p > t.price;
  return false;
}
