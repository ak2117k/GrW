import { Injectable } from '@nestjs/common';
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
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

const ALL_TRIPWIRES: Tripwire[] = [
  givebackOffPeak,
  levelBreak,
  volumeAnomaly,
  oiWallShift,
  newsHit,
  contextFactorFlip,
];

export interface TripwireResult {
  fires: TripwireFire[];
  heartbeat: boolean;
  /** True when the agent should be woken: something fired, or the heartbeat is due. */
  shouldEvaluate: boolean;
}

@Injectable()
export class TripwireService {
  evaluate(input: TripwireInput, lastVerdictAt: Date | null, now: Date): TripwireResult {
    const fires = ALL_TRIPWIRES
      .map((t) => t.check(input))
      .filter((f): f is TripwireFire => f !== null);

    const heartbeat =
      lastVerdictAt === null || now.getTime() - lastVerdictAt.getTime() >= HEARTBEAT_INTERVAL_MS;

    return { fires, heartbeat, shouldEvaluate: fires.length > 0 || heartbeat };
  }
}
