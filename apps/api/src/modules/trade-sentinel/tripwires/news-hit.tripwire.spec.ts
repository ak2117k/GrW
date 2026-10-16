import { newsHit } from './news-hit.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: 0, factorValues: {}, prevFactorValues: {},
};

describe('newsHit', () => {
  it('stays silent when there are no fresh headlines', () => {
    expect(newsHit.check({ ...base, freshNewsCount: 0 })).toBeNull();
  });

  it('fires on a single fresh headline', () => {
    const fire = newsHit.check({ ...base, freshNewsCount: 1 });
    expect(fire?.name).toBe('news-hit');
    expect(fire?.detail).toContain('1 fresh headline(s)');
  });

  it('reports the headline count it saw', () => {
    expect(newsHit.check({ ...base, freshNewsCount: 4 })?.detail).toContain('4 fresh headline(s)');
  });

  it('stays silent — and never reports a count — when the news feed is unavailable', () => {
    // Absent data is not a signal. A guard that only compared `< 1` would let
    // null through and emit "null fresh headline(s)" to the agent as evidence.
    expect(newsHit.check({ ...base, freshNewsCount: null })).toBeNull();
  });

  it('stays silent on a NaN count rather than reporting "NaN fresh headline(s)"', () => {
    // NaN < 1 is false, so a threshold test alone would fire and hand the agent
    // a fabricated headline count as evidence.
    expect(newsHit.check({ ...base, freshNewsCount: NaN })).toBeNull();
  });

  it('stays silent on an undefined count', () => {
    const missing = undefined as unknown as number;
    expect(newsHit.check({ ...base, freshNewsCount: missing })).toBeNull();
  });
});

describe('edge mode (news & events v2 true): newsUnseen present', () => {
  const edge = { ...base, freshNewsCount: 4 };
  it('fires on unseen ids with the newest title; ignores the 30-min count', () => {
    expect(newsHit.check({ ...edge, newsUnseen: [{ id: 'a', title: 'Infosys wins $1.5bn deal' }] })).toEqual({
      name: 'news-hit',
      detail: 'new headline on this instrument: "Infosys wins $1.5bn deal"',
    });
    expect(newsHit.check({ ...edge, newsUnseen: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })?.detail).toBe(
      '2 new headlines on this instrument, newest: "A"',
    );
  });
  it('an empty unseen list is silent even when the 30-min count is high (already fired on them)', () => {
    expect(newsHit.check({ ...edge, newsUnseen: [] })).toBeNull();
  });
  it('absent newsUnseen keeps the level-triggered rule exactly', () => {
    expect(newsHit.check(edge)?.detail).toBe('4 fresh headline(s) in the last 30 minutes');
  });
});
