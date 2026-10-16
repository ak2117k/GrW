import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * News & events v2: a timed high-impact event (results time, RBI, FOMC, CPI, EIA,
 * OPEC, own expiry) is minutes away. Reports WHAT is coming — never what to do: an
 * event alone is not a reason for EXIT_NOW, and the exit-discipline gate does not
 * accept it as one. Silent unless the input carries `eventNear`, which the cycle
 * sets only with NEWS_EVENTS_V2_ENABLED=true.
 */
export const eventNear: Tripwire = {
  name: 'event-near',
  check({ eventNear: e }: TripwireInput): TripwireFire | null {
    if (!e) return null;
    return { name: 'event-near', detail: `high-impact event in ${e.minutesAway} min: ${e.title}` };
  },
};
