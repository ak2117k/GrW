import { eventNear } from './event-near.tripwire';
import type { TripwireInput } from './types';

it('fires only with an eventNear input, naming the event and the minutes', () => {
  expect(eventNear.check({} as TripwireInput)).toBeNull();
  expect(eventNear.check({ eventNear: null } as never)).toBeNull();
  expect(eventNear.check({ eventNear: { id: 'e', title: 'EIA weekly petroleum status report', minutesAway: 12 } } as never)).toEqual({
    name: 'event-near',
    detail: 'high-impact event in 12 min: EIA weekly petroleum status report',
  });
});
