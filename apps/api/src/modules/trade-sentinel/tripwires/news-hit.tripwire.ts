import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Fresh headlines exist for this symbol. Sentiment is deliberately NOT judged
 * here — the aggregator's sentiment score is one more piece of evidence for the
 * agent, not a trigger condition.
 */
export const newsHit: Tripwire = {
  name: 'news-hit',

  check({ freshNewsCount }: TripwireInput): TripwireFire | null {
    // Absent data is not a signal. `=== null` alone is not enough: `undefined`
    // and `NaN` both fail `< 1`, so they would fire and hand the agent
    // "NaN fresh headline(s)" as evidence. A non-reading is not a reading.
    if (freshNewsCount === null || !Number.isFinite(freshNewsCount)) return null;
    if (freshNewsCount < 1) return null;
    return { name: 'news-hit', detail: `${freshNewsCount} fresh headline(s) in the last 30 minutes` };
  },
};
