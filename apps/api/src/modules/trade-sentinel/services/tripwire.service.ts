import { Injectable, Logger } from '@nestjs/common';
import type { Tripwire, TripwireFire, TripwireInput } from '../tripwires/types';
import { givebackOffPeak } from '../tripwires/giveback-off-peak.tripwire';
import { levelBreak } from '../tripwires/level-break.tripwire';
import { volumeAnomaly } from '../tripwires/volume-anomaly.tripwire';
import { oiWallShift } from '../tripwires/oi-wall-shift.tripwire';
import { newsHit } from '../tripwires/news-hit.tripwire';
import { contextFactorFlip } from '../tripwires/context-factor-flip.tripwire';

/**
 * How long a watched position may go unexamined when every sensor is quiet.
 * The heartbeat exists so a slow grinding bleed — which by construction trips
 * nothing — cannot hide beneath the sensors' thresholds.
 *
 * This is now the NEAR-RISK cadence rather than the only one. See
 * {@link heartbeatIntervalMs}.
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The quiet cadence: a position that is far from every level, with an unarmed
 * floor, is reviewed hourly rather than four times an hour.
 *
 * WHY THIS EXISTS AT ALL — it is an economics fix, and the economics were
 * genuinely broken. At a flat 15 minutes, ~25 of every ~30 daily model calls per
 * position were heartbeats, i.e. the agent being paid to conclude that nothing
 * had happened. On Opus that is roughly ₹8,000 a month to watch ONE option,
 * against trades whose whole downside is a ₹1,500 loss. A monitor that costs
 * more than the losses it prevents is not a monitor, it is a subscription.
 *
 * The cost had to scale with EVENTS rather than with elapsed time. Responsiveness
 * is unaffected where it matters: the tripwires are free, run every 30 seconds
 * regardless, and wake the agent immediately — this only slows the routine
 * "nothing tripped, look anyway" pass, and only while the position is calm.
 */
export const HEARTBEAT_QUIET_MS = 60 * 60 * 1000;

/**
 * The absolute ceiling. However quiet and however unchanged, a live position is
 * never left unexamined longer than this.
 *
 * The material-change gate below is the right default and the wrong ONLY rule:
 * it reasons entirely from prices, and some things that should provoke a fresh
 * look move no price at all — an approaching expiry, a thesis the agent itself
 * flagged as weakening, a market that has simply gone still around a position
 * that is deep in trouble. This bound is what stops a clever cost optimisation
 * from becoming a blind spot, and it fires regardless of what changed.
 */
export const HEARTBEAT_MAX_MS = 90 * 60 * 1000;

/**
 * How far the contract's own price must move, as a fraction, before a QUIET
 * heartbeat is worth spending a model call on.
 *
 * 1% of the premium — on a ₹270 option that is ₹2.70. Deliberately a fraction
 * and not an absolute: the same rule has to hold for a ₹5 far-OTM contract and a
 * ₹2,000 deep-ITM one.
 */
export const MATERIAL_MOVE_PCT = 0.01;

/**
 * What the agent saw the last time it actually judged this position, reduced to
 * the handful of facts that decide whether looking again could change anything.
 *
 * Read from the STORED PACKET of the previous verdict rather than tracked in
 * memory: the packet is already persisted verbatim, it is what the agent
 * genuinely saw, and it survives a restart — which in-process state does not. A
 * gate that forgets its baseline on every deploy silently degrades to "always
 * evaluate", which is the behaviour it exists to prevent.
 */
export interface LastJudged {
  ltp: number;
  greenFloorArmed: boolean;
  qty: number;
}

/**
 * Whether anything has changed since the last judgement that could plausibly
 * change the verdict. Pure, and free — this is arithmetic, not judgement, and
 * that is the entire point: most ticks the answer is obviously "nothing
 * happened", and paying a model to say so is the waste being removed.
 *
 * Null baseline means never judged, which is always material.
 *
 * Three things count, and they are not interchangeable:
 *  - the PRICE moved beyond the noise band (the ordinary case);
 *  - the green floor ARMED or un-armed, which changes what the trade even is —
 *    a position that has just cleared its charges is a different decision from
 *    one that has not, at an identical price;
 *  - the QUANTITY changed, meaning the user part-closed or added. The agent is
 *    reasoning about a different position than the one it last judged, and no
 *    price test would ever notice.
 */
export function materiallyChanged(last: LastJudged | null, now: LastJudged): boolean {
  if (last === null) return true;
  if (last.greenFloorArmed !== now.greenFloorArmed) return true;
  if (last.qty !== now.qty) return true;
  if (!Number.isFinite(last.ltp) || last.ltp <= 0) return true;
  return Math.abs(now.ltp - last.ltp) / last.ltp >= MATERIAL_MOVE_PCT;
}

/**
 * How often this position should be reviewed when no sensor has fired.
 *
 * Risk, not the clock. A position sitting on a level, or one whose floor has
 * armed and therefore has profit to protect, gets the tight cadence; one far
 * from anything with nothing yet to lose gets the quiet one.
 *
 * `armed` is the LATCHED value the cycle maintains, not `computeGreenFloor`'s
 * per-tick snapshot — a floor that un-arms on a pullback is not a floor, and
 * reading the snapshot here would make the cadence oscillate with the market.
 */
export function heartbeatIntervalMs(
  input: Pick<TripwireInput, 'underlyingLtp' | 'nearestSupport' | 'nearestResistance'>,
  armed: boolean,
): number {
  if (armed) return HEARTBEAT_INTERVAL_MS;
  const price = input.underlyingLtp;
  if (!Number.isFinite(price as number) || (price as number) <= 0) {
    // No price to measure distance with. Assume the tight cadence: not knowing
    // where you are relative to a level is not the same as being far from one,
    // and this is the branch a blind packet lands in.
    return HEARTBEAT_INTERVAL_MS;
  }
  const near = (level: number | null) =>
    level !== null &&
    Number.isFinite(level) &&
    Math.abs((price as number) - level) / (price as number) < NEAR_LEVEL_PCT;
  return near(input.nearestSupport) || near(input.nearestResistance)
    ? HEARTBEAT_INTERVAL_MS
    : HEARTBEAT_QUIET_MS;
}

/** Within 1% of a level counts as "at" it for cadence purposes. */
export const NEAR_LEVEL_PCT = 0.01;

const ALL_TRIPWIRES: Tripwire[] = [
  givebackOffPeak,
  levelBreak,
  volumeAnomaly,
  oiWallShift,
  newsHit,
  contextFactorFlip,
];

/**
 * WHY the agent is being woken. Drives model selection — see
 * `SentinelAgentService.judge`.
 *
 * The distinction is real and not merely bookkeeping: a FIRE means a sensor
 * detected something and the packet contains a specific claim to adjudicate; a
 * HEARTBEAT means nothing detected anything and the agent is being asked to look
 * anyway. Those are different questions and they do not need the same model.
 */
export type WakeTrigger = 'FIRE' | 'HEARTBEAT';

export interface TripwireResult {
  fires: TripwireFire[];
  heartbeat: boolean;
  /** True when the agent should be woken: something fired, or the heartbeat is due. */
  shouldEvaluate: boolean;
  /** Set only when `shouldEvaluate`. Null when this tick is being skipped. */
  trigger: WakeTrigger | null;
}

/** Everything the heartbeat decision needs beyond the sensors' own input. */
export interface HeartbeatContext {
  /** The latched floor state — see {@link heartbeatIntervalMs}. */
  greenFloorArmed: boolean;
  /** What the agent saw last time, or null on first sight. */
  lastJudged: LastJudged | null;
  /** This tick's equivalent, for the material-change comparison. */
  current: LastJudged;
}

@Injectable()
export class TripwireService {
  private readonly logger = new Logger(TripwireService.name);

  /**
   * `context` is optional so existing callers and tests keep their behaviour: a
   * caller that supplies none gets the original flat 15-minute heartbeat with no
   * material-change gate. New callers pass it and get the cost controls.
   */
  evaluate(
    input: TripwireInput,
    lastVerdictAt: Date | null,
    now: Date,
    context?: HeartbeatContext,
  ): TripwireResult {
    const fires = ALL_TRIPWIRES
      .map((t) => this.checkSafely(t, input))
      .filter((f): f is TripwireFire => f !== null);

    // A FIRE always wakes the agent, unconditionally and immediately. The gate
    // below governs only the routine pass — cost control must never be able to
    // suppress a sensor that actually detected something.
    if (fires.length > 0) {
      return { fires, heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' };
    }

    const sinceMs =
      lastVerdictAt === null ? Number.POSITIVE_INFINITY : now.getTime() - lastVerdictAt.getTime();

    if (!context) {
      const heartbeat = sinceMs >= HEARTBEAT_INTERVAL_MS;
      return { fires, heartbeat, shouldEvaluate: heartbeat, trigger: heartbeat ? 'HEARTBEAT' : null };
    }

    // The ceiling first: it outranks the gate on purpose. See HEARTBEAT_MAX_MS —
    // the gate reasons only from prices, and the things it cannot see are exactly
    // the ones worth a guaranteed look.
    if (sinceMs >= HEARTBEAT_MAX_MS) {
      return { fires, heartbeat: true, shouldEvaluate: true, trigger: 'HEARTBEAT' };
    }

    const due = sinceMs >= heartbeatIntervalMs(input, context.greenFloorArmed);
    const changed = materiallyChanged(context.lastJudged, context.current);
    const heartbeat = due && changed;
    return { fires, heartbeat, shouldEvaluate: heartbeat, trigger: heartbeat ? 'HEARTBEAT' : null };
  }

  /**
   * One sensor's failure must never blind the other five. Without this, a single
   * `check` that throws propagates out of `evaluate`, the cycle counts the whole
   * position as failed and skips it — no fires from any other sensor, no packet,
   * no verdict. A broken sensor degrades to silence, loudly logged.
   */
  private checkSafely(tripwire: Tripwire, input: TripwireInput): TripwireFire | null {
    try {
      return tripwire.check(input);
    } catch (err) {
      this.logger.error(
        `tripwire "${tripwire.name}" threw on ${input.symbol} (tracker ${input.trackerId}); ` +
          `treating it as silent — the other sensors still ran: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return null;
    }
  }
}
