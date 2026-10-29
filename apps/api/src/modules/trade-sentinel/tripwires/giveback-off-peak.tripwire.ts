import { noiseGiveback } from '../../exit-discipline/giveback';
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Fraction of peak favourable excursion that must be surrendered before this
 * sensor speaks — the rule when no noise unit is known (exit discipline §5). Deliberately loose: a sensor's job is "look at this", not
 * "sell this", so a false alarm costs one agent call, not a trade.
 *
 * SAME FOR CASH EQUITY, deliberately (2026-10-29). Unlike the fixed-% price
 * steps elsewhere on the cycle, this is a fraction of the trade's OWN excursion,
 * so it already scales with how far the instrument actually moved — a stock's
 * smaller swing gives a smaller excursion and a proportionally smaller giveback.
 * The volatility-aware rule is the noise unit below, and a cash position gets
 * one (the stock's own 1-minute ATR, from the tick source's cash path) whenever
 * exit discipline is on; this fallback runs only when no unit was measured.
 */
export const GIVEBACK_FRACTION = 0.4;

/**
 * MFE giveback: the trade WAS up, and has since surrendered a meaningful share
 * of that gain. Measured off holdingHigh for longs and holdingLow for shorts —
 * the running extremes the trade-tracker already maintains per tick.
 */
export const givebackOffPeak: Tripwire = {
  name: 'giveback-off-peak',

  check(input: TripwireInput): TripwireFire | null {
    const { side, entryPrice, ltp, holdingHigh, holdingLow } = input;
    const peak = side === 'LONG' ? holdingHigh : holdingLow;
    // Absent data is not a signal. `=== null` alone is not enough: a NaN peak
    // makes `peakGain` NaN, and `NaN <= 0` is false, so the guard below waves it
    // through and the agent is handed "gave back NaN% of peak excursion (peak
    // NaN, now 108, entry 100)" as evidence. A NaN ltp or entry does the same to
    // `givenBack`, which then fails `givenBack < threshold` and fires. Same
    // `Number.isFinite` defence as volumeAnomaly and newsHit — the point of
    // hardening a sensor is that the producer chain is not trusted.
    if (peak === null || !Number.isFinite(peak)) return null;
    if (!Number.isFinite(ltp) || !Number.isFinite(entryPrice)) return null;

    // Exit discipline §5: with a measured noise unit, speak only on a pullback of
    // GIVEBACK_N units after an excursion of FLOOR_ARM_N units — a smaller
    // pullback is the instrument's ordinary swing. Without one, the 40 % rule.
    if (input.noise) {
      const g = noiseGiveback({ side, entryPrice, ltp, peak, n: input.noise.n, armN: input.noise.armN, givebackN: input.noise.givebackN });
      if (!g || !g.fire) return null;
      const n = input.noise.n;
      return {
        name: 'giveback-off-peak',
        detail:
          `gave back ${g.pullback.toFixed(1)} (${(g.pullback / n).toFixed(1)} N) from peak ${peak} after a ` +
          `${g.excursion.toFixed(1)} (${(g.excursion / n).toFixed(1)} N) excursion; now ${ltp}, entry ${entryPrice}, N=${n.toFixed(2)}`,
      };
    }

    const dir = side === 'LONG' ? 1 : -1;
    const peakGain = (peak - entryPrice) * dir;
    if (peakGain <= 0) return null; // never went right — a different sensor's problem

    const currentGain = (ltp - entryPrice) * dir;
    const givenBack = peakGain - currentGain;
    if (givenBack < peakGain * GIVEBACK_FRACTION) return null;

    const pct = Math.round((givenBack / peakGain) * 100);
    return {
      name: 'giveback-off-peak',
      detail: `gave back ${pct}% of peak excursion (peak ${peak}, now ${ltp}, entry ${entryPrice})`,
    };
  },
};
