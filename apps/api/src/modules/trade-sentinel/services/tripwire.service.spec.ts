import { Logger } from '@nestjs/common';
import {
  TripwireService,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MS,
  HEARTBEAT_QUIET_MS,
  heartbeatIntervalMs,
  materiallyChanged,
  type HeartbeatContext,
  type LastJudged,
} from './tripwire.service';
import { volumeAnomaly } from '../tripwires/volume-anomaly.tripwire';
import type { TripwireInput } from '../tripwires/types';

const quiet: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: 100, holdingLow: 100,
  nearestSupport: 90, nearestResistance: 110,
  volumeRatio: 1, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: 0, factorValues: {}, prevFactorValues: {},
};

describe('TripwireService', () => {
  const svc = new TripwireService();
  const now = new Date('2026-08-14T10:00:00Z');

  it('does not evaluate when nothing fired and the heartbeat is not due', () => {
    const justNow = new Date(now.getTime() - 1000);
    const result = svc.evaluate(quiet, justNow, now);
    expect(result.fires).toEqual([]);
    expect(result.shouldEvaluate).toBe(false);
  });

  it('evaluates on the heartbeat even when every sensor is silent', () => {
    const stale = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS - 1);
    const result = svc.evaluate(quiet, stale, now);
    expect(result.heartbeat).toBe(true);
    expect(result.shouldEvaluate).toBe(true);
  });

  it('always evaluates a position that has never been looked at', () => {
    expect(svc.evaluate(quiet, null, now).shouldEvaluate).toBe(true);
  });

  it('collects every sensor that fired, not just the first', () => {
    const noisy: TripwireInput = {
      ...quiet,
      holdingHigh: 130, ltp: 105,   // giveback
      nearestSupport: 110,          // level break
      volumeRatio: 5,               // volume spike
      freshNewsCount: 3,            // news
    };
    const result = svc.evaluate(noisy, new Date(now.getTime() - 1000), now);
    const names = result.fires.map((f) => f.name).sort();
    expect(names).toEqual(['giveback-off-peak', 'level-break', 'news-hit', 'volume-anomaly']);
    expect(result.shouldEvaluate).toBe(true);
  });

  it('runs all six sensors, so none can be dropped from the roster unnoticed', () => {
    const everything: TripwireInput = {
      ...quiet,
      holdingHigh: 130, ltp: 105,                              // giveback
      underlyingLtp: 105, nearestSupport: 110,                 // level break
      volumeRatio: 5,                                          // volume spike
      oiWallNow: { callWall: 23800, putWall: null },           // wall closing in
      oiWallPrev: { callWall: 24000, putWall: null },
      freshNewsCount: 3,                                       // news
      factorValues: { greeks: -0.4 },                          // factor flip
      prevFactorValues: { greeks: 0.6 },
    };
    const names = svc.evaluate(everything, new Date(now.getTime() - 1000), now).fires
      .map((f) => f.name)
      .sort();
    expect(names).toEqual([
      'context-factor-flip', 'giveback-off-peak', 'level-break',
      'news-hit', 'oi-wall-shift', 'volume-anomaly',
    ]);
  });

  it('wakes the agent on a lone quiet-position factor flip, with the heartbeat not due', () => {
    const flipped: TripwireInput = {
      ...quiet,
      factorValues: { volatility: 0.5 },
      prevFactorValues: { volatility: -0.5 },
    };
    const result = svc.evaluate(flipped, new Date(now.getTime() - 1000), now);
    expect(result.heartbeat).toBe(false);
    expect(result.fires.map((f) => f.name)).toEqual(['context-factor-flip']);
    expect(result.shouldEvaluate).toBe(true);
  });

  it('beats exactly on the interval, not a tick later', () => {
    const due = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS);
    expect(svc.evaluate(quiet, due, now).heartbeat).toBe(true);

    const oneMsShort = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS + 1);
    expect(svc.evaluate(quiet, oneMsShort, now).heartbeat).toBe(false);
  });

  describe('when one sensor is broken', () => {
    afterEach(() => jest.restoreAllMocks());

    const noisy: TripwireInput = {
      ...quiet,
      holdingHigh: 130, ltp: 105,   // giveback
      nearestSupport: 110,          // level break
      volumeRatio: 5,               // volume spike (this is the sensor we break)
      freshNewsCount: 3,            // news
    };

    it('does not let a throwing sensor blind the other five', () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(volumeAnomaly, 'check').mockImplementation(() => {
        throw new Error('boom');
      });

      const result = svc.evaluate(noisy, new Date(now.getTime() - 1000), now);

      // volume-anomaly is absent because it broke; the rest still reported.
      expect(result.fires.map((f) => f.name).sort())
        .toEqual(['giveback-off-peak', 'level-break', 'news-hit']);
      expect(result.shouldEvaluate).toBe(true);
    });

    it('does not propagate the sensor failure out of evaluate', () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(volumeAnomaly, 'check').mockImplementation(() => {
        throw new Error('boom');
      });

      expect(() => svc.evaluate(noisy, null, now)).not.toThrow();
    });

    it('logs the failure with the offending sensor name', () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(volumeAnomaly, 'check').mockImplementation(() => {
        throw new Error('boom');
      });

      svc.evaluate(noisy, null, now);

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0][0]).toContain('volume-anomaly');
      expect(logged.mock.calls[0][0]).toContain('boom');
    });

    it('still reaches the heartbeat decision when a sensor throws', () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(volumeAnomaly, 'check').mockImplementation(() => {
        throw new Error('boom');
      });

      const stale = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS);
      expect(svc.evaluate(quiet, stale, now).heartbeat).toBe(true);
    });
  });

  it('never throws when a sensor sees only nulls', () => {
    const blank: TripwireInput = {
      ...quiet,
      holdingHigh: null, holdingLow: null,
      nearestSupport: null, nearestResistance: null,
      underlyingLtp: null,
      volumeRatio: null, freshNewsCount: null,
    };
    expect(() => svc.evaluate(blank, null, now)).not.toThrow();
    // Absent data is not a signal: nothing may fire off nulls alone.
    expect(svc.evaluate(blank, null, now).fires).toEqual([]);
  });
});

/**
 * THE COST LAYERS. At a flat 15-minute heartbeat, ~25 of every ~30 daily model
 * calls per position were the agent being paid to conclude that nothing had
 * happened — roughly ₹8,000 a month to watch one option, against trades whose
 * whole downside is a fraction of that. A monitor that costs more than the
 * losses it prevents is a subscription, not a monitor.
 *
 * These tests pin the two properties that make the saving safe: a FIRE is never
 * suppressed, and no position is ever left unexamined past the ceiling.
 */
describe('cost controls', () => {
  const near = (over: Partial<Record<string, unknown>> = {}) =>
    ({ underlyingLtp: 100, nearestSupport: 99.5, nearestResistance: 120, ...over }) as never;
  const far = { underlyingLtp: 100, nearestSupport: 80, nearestResistance: 120 } as never;
  const judged = (over: Partial<LastJudged> = {}): LastJudged => ({
    ltp: 100,
    qty: 75,
    greenFloorArmed: false,
    ...over,
  });

  describe('heartbeatIntervalMs', () => {
    it('keeps the tight cadence when price sits on a level', () => {
      expect(heartbeatIntervalMs(near(), false)).toBe(HEARTBEAT_INTERVAL_MS);
    });

    it('keeps the tight cadence when the floor is armed', () => {
      // Armed means there is realised profit to protect. Cadence follows risk,
      // and a position with something to lose is the risky one.
      expect(heartbeatIntervalMs(far, true)).toBe(HEARTBEAT_INTERVAL_MS);
    });

    it('relaxes to the quiet cadence far from everything', () => {
      expect(heartbeatIntervalMs(far, false)).toBe(HEARTBEAT_QUIET_MS);
    });

    it('assumes the TIGHT cadence when there is no price to measure with', () => {
      // Not knowing where you are relative to a level is not the same as being
      // far from one. A blind packet must not buy itself a cheaper cadence.
      expect(
        heartbeatIntervalMs(
          { underlyingLtp: null, nearestSupport: 80, nearestResistance: 120 },
          false,
        ),
      ).toBe(HEARTBEAT_INTERVAL_MS);
    });
  });

  describe('materiallyChanged', () => {
    it('treats a first look as material', () => {
      expect(materiallyChanged(null, judged())).toBe(true);
    });

    it('ignores a move inside the noise band', () => {
      expect(materiallyChanged(judged({ ltp: 100 }), judged({ ltp: 100.5 }))).toBe(false);
    });

    it('catches a move past the band, in either direction', () => {
      expect(materiallyChanged(judged({ ltp: 100 }), judged({ ltp: 101.2 }))).toBe(true);
      expect(materiallyChanged(judged({ ltp: 100 }), judged({ ltp: 98.8 }))).toBe(true);
    });

    it('catches the floor arming at an unchanged price', () => {
      // A position that has just cleared its charges is a different decision
      // from one that has not, even at an identical price.
      expect(
        materiallyChanged(judged({ greenFloorArmed: false }), judged({ greenFloorArmed: true })),
      ).toBe(true);
    });

    it('catches a part-close, which no price test would notice', () => {
      expect(materiallyChanged(judged({ qty: 75 }), judged({ qty: 25 }))).toBe(true);
    });
  });

  describe('evaluate', () => {
    const svc = new TripwireService();
    const input = {
      underlyingLtp: 100,
      nearestSupport: 80,
      nearestResistance: 120,
      trackerId: 't1',
      symbol: 'KEI29SEP265800CE',
    } as never;
    const ctx = (over: Partial<HeartbeatContext> = {}): HeartbeatContext => ({
      greenFloorArmed: false,
      lastJudged: judged(),
      current: judged(),
      ...over,
    });
    const now = new Date('2026-08-18T06:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);

    it('skips a due heartbeat when nothing material changed', () => {
      // The whole saving: quiet position, nothing moved, no call spent.
      const out = svc.evaluate(input, ago(HEARTBEAT_QUIET_MS + 1), now, ctx());
      expect(out.shouldEvaluate).toBe(false);
      expect(out.trigger).toBeNull();
    });

    it('takes the heartbeat when something material DID change', () => {
      const out = svc.evaluate(
        input,
        ago(HEARTBEAT_QUIET_MS + 1),
        now,
        ctx({ current: judged({ ltp: 110 }) }),
      );
      expect(out.shouldEvaluate).toBe(true);
      expect(out.trigger).toBe('HEARTBEAT');
    });

    it('ALWAYS looks past the ceiling, however unchanged', () => {
      // The gate reasons only from prices. An approaching expiry, a weakening
      // thesis, a market gone still around a position in trouble — none of them
      // move a price, and all of them deserve a look.
      const out = svc.evaluate(input, ago(HEARTBEAT_MAX_MS + 1), now, ctx());
      expect(out.shouldEvaluate).toBe(true);
      expect(out.trigger).toBe('HEARTBEAT');
    });

    it('does not wake before the quiet interval even on a material move', () => {
      const out = svc.evaluate(
        input,
        ago(HEARTBEAT_INTERVAL_MS + 1),
        now,
        ctx({ current: judged({ ltp: 110 }) }),
      );
      // Far from levels, unarmed: the cadence is hourly, and a price move alone
      // does not shorten it — that is what the tripwires are for.
      expect(out.shouldEvaluate).toBe(false);
    });

    it('preserves the old behaviour when no context is supplied', () => {
      const out = svc.evaluate(input, ago(HEARTBEAT_INTERVAL_MS + 1), now);
      expect(out.shouldEvaluate).toBe(true);
      expect(out.trigger).toBe('HEARTBEAT');
    });
  });
});
