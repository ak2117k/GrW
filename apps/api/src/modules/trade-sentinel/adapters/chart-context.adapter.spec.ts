import { Logger } from '@nestjs/common';
import type { LevelsSnapshot } from '../../signal-generator/services/signal-generator.service';
import {
  SENTINEL_LEVEL_INTERVAL,
  SENTINEL_LEVEL_SOURCE,
  SentinelChartContextAdapter,
  levelCandidates,
  nearestLevels,
} from './chart-context.adapter';

const levels = (over: Partial<LevelsSnapshot> = {}): LevelsSnapshot => ({
  pdh: 110,
  pdl: 90,
  orh: 106,
  orl: 96,
  prevOrh: 108,
  prevOrl: 92,
  vwap: 100,
  todayHigh: 107,
  todayLow: 95,
  atr14: 3,
  ...over,
});

function make() {
  const analyze = jest.fn();
  const getInstrumentBySymbol = jest.fn().mockResolvedValue({
    token: '12345',
    exchange: 'NSE',
    symbol: 'SUZLON-EQ',
  });
  const svc = new SentinelChartContextAdapter(
    { analyze } as never,
    { getInstrumentBySymbol } as never,
  );
  analyze.mockResolvedValue({ kind: 'setup', levels: levels(), volumeRatio: 2.5 });
  return { svc, analyze, getInstrumentBySymbol };
}

describe('levelCandidates', () => {
  it('drops non-finite entries rather than comparing them', () => {
    // A NaN VWAP that survived into a comparison reads as "no level" one tick
    // and as a breach the next, and `levelBreak` fires on the artefact.
    const out = levelCandidates(levels({ vwap: Number.NaN, orh: null, prevOrl: null }));
    expect(out).toEqual([110, 90, 96, 108, 107, 95]);
  });
});

describe('nearestLevels', () => {
  it('picks the closest level on each side of the price', () => {
    expect(nearestLevels(levels(), 100.5)).toEqual({
      nearestSupport: 100,
      nearestResistance: 106,
    });
  });

  it('is STRICT on both sides — a level you are sitting on is not support', () => {
    // Admitting it would make `levelBreak` fire the instant price ticked one
    // paisa through a line it was merely resting on.
    expect(nearestLevels(levels(), 100)).toEqual({
      nearestSupport: 96,
      nearestResistance: 106,
    });
  });

  it('returns null on a side with no level, rather than the nearest on the wrong side', () => {
    expect(nearestLevels(levels(), 5)).toEqual({
      nearestSupport: null,
      nearestResistance: 90,
    });
    expect(nearestLevels(levels(), 500)).toEqual({
      nearestSupport: 110,
      nearestResistance: null,
    });
  });

  it('stays silent on a non-finite price', () => {
    expect(nearestLevels(levels(), Number.NaN)).toEqual({
      nearestSupport: null,
      nearestResistance: null,
    });
  });
});

describe('SentinelChartContextAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('names the interval in the provenance, so two packets are distinguishable', async () => {
    const t = make();
    const result = await t.svc.levelsFor('SUZLON-EQ');

    // Without this, one stored packet could carry a 5-minute level book and
    // another a daily one under the same `source` string, and Task 13's replay
    // could not tell them apart.
    expect(result?.source).toBe(SENTINEL_LEVEL_SOURCE);
    expect(result?.source).toContain(SENTINEL_LEVEL_INTERVAL);
    expect((result?.value as { interval: string }).interval).toBe(SENTINEL_LEVEL_INTERVAL);
  });

  it('builds the level book at the chosen interval and nothing else', async () => {
    const t = make();
    await t.svc.levelsFor('SUZLON-EQ');
    expect(t.analyze).toHaveBeenCalledWith('12345', 'NSE', 'SUZLON-EQ', SENTINEL_LEVEL_INTERVAL);
  });

  it('returns null when the instrument cannot be resolved', async () => {
    const t = make();
    t.getInstrumentBySymbol.mockResolvedValue(null);
    await expect(t.svc.levelsFor('NOSUCH')).resolves.toBeNull();
  });

  it('returns null when analyze produced no level book', async () => {
    const t = make();
    t.analyze.mockResolvedValue({ kind: 'no-setup' });
    await expect(t.svc.levelsFor('SUZLON-EQ')).resolves.toBeNull();
  });

  it('degrades to null on a throw, and says so at warn', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = make();
    t.analyze.mockRejectedValue(new Error('not authenticated'));

    await expect(t.svc.levelsFor('SUZLON-EQ')).resolves.toBeNull();
    // A permanently failing level book makes `levelBreak` silent in a way that
    // is indistinguishable from "price never touched a level".
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('not authenticated');
  });

  it('serves both reads from ONE analyze call', async () => {
    const t = make();
    await t.svc.levelsFor('SUZLON-EQ');
    await t.svc.structureFor('SUZLON-EQ', 100.5);
    expect(t.analyze).toHaveBeenCalledTimes(1);
  });

  it('caches by BASE symbol, so the two spellings do not build it twice', async () => {
    const t = make();
    await t.svc.levelsFor('SUZLON-EQ');
    await t.svc.levelsFor('SUZLON');
    expect(t.analyze).toHaveBeenCalledTimes(1);
  });

  it('does not cache a THROWN failure — the next tick must retry', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = make();
    t.analyze.mockRejectedValueOnce(new Error('transient'));

    await expect(t.svc.levelsFor('SUZLON-EQ')).resolves.toBeNull();
    await expect(t.svc.levelsFor('SUZLON-EQ')).resolves.not.toBeNull();
  });

  it('stamps `at` with when the book was derived, not when it was asked for', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T06:00:00Z'));
    const t = make();
    const first = await t.svc.levelsFor('SUZLON-EQ');

    jest.setSystemTime(new Date('2026-08-14T06:00:30Z'));
    const second = await t.svc.levelsFor('SUZLON-EQ');

    jest.useRealTimers();
    // Both reads served the same cached book, so both must claim the same
    // capture time — a fresh `at` on stale data is provenance that lies.
    expect(second?.at).toBe(first?.at);
    expect(first?.at).toBe('2026-08-14T06:00:00.000Z');
  });

  it('reports the volume ratio alongside the levels', async () => {
    const t = make();
    await expect(t.svc.structureFor('SUZLON-EQ', 100.5)).resolves.toEqual({
      nearestSupport: 100,
      nearestResistance: 106,
      volumeRatio: 2.5,
    });
  });

  it('stays silent on levels without a price, but still reports the volume ratio', async () => {
    const t = make();
    await expect(t.svc.structureFor('SUZLON-EQ', null)).resolves.toEqual({
      nearestSupport: null,
      nearestResistance: null,
      volumeRatio: 2.5,
    });
  });

  it('drops a non-finite volume ratio rather than passing NaN to a sensor', async () => {
    const t = make();
    t.analyze.mockResolvedValue({ kind: 'setup', levels: levels(), volumeRatio: Number.NaN });
    const result = await t.svc.structureFor('SUZLON-EQ', 100.5);
    expect(result.volumeRatio).toBeNull();
  });
});
