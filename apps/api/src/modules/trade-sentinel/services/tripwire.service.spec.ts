import { Logger } from '@nestjs/common';
import { TripwireService, HEARTBEAT_INTERVAL_MS } from './tripwire.service';
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
