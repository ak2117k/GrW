import { Logger } from '@nestjs/common';
import type { LevelsSnapshot } from '../../signal-generator/services/signal-generator.service';
import {
  FACTORS_ALL_STUBBED,
  FACTORS_NOT_SCORED,
  FACTORS_NO_BOOK,
  FACTORS_NO_SETUP,
  LEVEL_BOOK_FAILED,
  LEVEL_BOOK_NO_PRICE,
  LEVEL_BOOK_UNBUILT,
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

/** The three real factors, as `ContextFactorBreakdown` spells them. */
const factors = (
  over: Array<{ name: string; value: number; isStub: boolean }> = [],
): Array<{ name: string; value: number; isStub: boolean }> =>
  over.length > 0
    ? over
    : [
        { name: 'greeks', value: 0.5, isStub: false },
        { name: 'mtfTrend', value: -0.4, isStub: false },
        // Excluded by `isStub`, not by name — a stub's neutral zero is not a
        // reading, and feeding it to `contextFactorFlip` manufactures signal.
        { name: 'fii', value: 0, isStub: true },
      ];

function make(opts: { withFeed?: boolean } = { withFeed: true }) {
  const analyze = jest.fn();
  const getInstrumentBySymbol = jest.fn().mockResolvedValue({
    token: '12345',
    exchange: 'NSE',
    symbol: 'SUZLON-EQ',
  });
  const fetchCandles = jest.fn().mockResolvedValue([]);
  const svc = new SentinelChartContextAdapter(
    { analyze } as never,
    { getInstrumentBySymbol } as never,
    opts.withFeed ? ({ fetchCandles } as never) : undefined,
  );
  analyze.mockResolvedValue({
    kind: 'setup',
    side: 'BUY',
    levels: levels(),
    volumeRatio: 2.5,
    contextFactors: factors(),
  });
  return { svc, analyze, getInstrumentBySymbol, fetchCandles };
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
    await t.svc.levelsFor('SUZLON-EQ', 'u1');
    expect(t.analyze).toHaveBeenCalledWith(
      '12345',
      'NSE',
      'SUZLON-EQ',
      SENTINEL_LEVEL_INTERVAL,
      expect.anything(),
    );
  });

  it("fetches candles over the OWNING USER's own session, not the shared adapter", async () => {
    // This platform has NO shared feed account: an analyze() without a
    // CandleSource reaches `AngelOneAdapterService`, which throws
    // `Not authenticated` for every call. Before this the level book was empty
    // for every symbol, permanently — and a permanently empty book is
    // indistinguishable from a symbol whose levels were never touched.
    const t = make();
    await t.svc.levelsFor('SUZLON-EQ', 'u1');

    const source = t.analyze.mock.calls[0][4] as {
      getCandles: (...a: unknown[]) => Promise<unknown>;
    };
    expect(source).toBeDefined();

    const from = new Date('2026-08-14T03:45:00Z');
    const to = new Date('2026-08-14T06:00:00Z');
    await source.getCandles('12345', 'NSE', '5m', from, to);
    // The userId must be the FIRST argument to fetchCandles — bound to the
    // position's owner, not to whoever happened to warm the cache.
    expect(t.fetchCandles).toHaveBeenCalledWith('u1', '12345', 'NSE', '5m', from, to);
  });

  it('passes NO source when there is no feed manager or no user, rather than inventing one', async () => {
    // The documented degradation: analyze() falls back to the shared-adapter
    // path. On this deployment that yields nothing, and the emptiness is then
    // reported WITH a reason rather than as a finding.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const noFeed = make({ withFeed: false });
    await noFeed.svc.levelsFor('SUZLON-EQ', 'u1');
    expect(noFeed.analyze.mock.calls[0][4]).toBeUndefined();

    // AT BOOT, AT WARN. A missing feed manager makes every sensor dark for the
    // life of the process; the one thing it must not also be is quiet.
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toMatch(/UserFeedManager/);

    const noUser = make();
    await noUser.svc.levelsFor('SUZLON-EQ', undefined);
    expect(noUser.analyze.mock.calls[0][4]).toBeUndefined();
  });

  it('returns null when the instrument cannot be resolved, and says so at WARN', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = make();
    t.getInstrumentBySymbol.mockResolvedValue(null);

    await expect(t.svc.levelsFor('NIFTY28AUG2524000CE')).resolves.toBeNull();

    // At debug this is silence in production, and an unresolvable symbol means
    // an empty level book for the LIFE of the position — indistinguishable
    // from a symbol whose levels were simply never touched.
    const logged = warn.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('NIFTY28AUG2524000CE');
    expect(logged).toMatch(/level book/i);
  });

  it('warns ONCE per symbol, not once per poll', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = make();
    t.getInstrumentBySymbol.mockResolvedValue(null);

    await t.svc.levelsFor('NOSUCH');
    await t.svc.levelsFor('NOSUCH');

    expect(warn.mock.calls.filter((c) => /NOSUCH/.test(String(c[0])))).toHaveLength(1);
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

  it('reports the volume ratio alongside the levels, and NO reason', async () => {
    const t = make();
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T06:00:00Z'));
    const result = await t.svc.structureFor('SUZLON-EQ', 100.5);
    jest.useRealTimers();

    expect(result).toEqual({
      nearestSupport: 100,
      nearestResistance: 106,
      volumeRatio: 2.5,
      // The book WAS built and WAS compared, so a null on either side would be a
      // true statement about the market and the packet's own wording stands.
      // Anything non-null here would suppress that wording for a real finding.
      reason: null,
      at: '2026-08-14T06:00:00.000Z',
      source: SENTINEL_LEVEL_SOURCE,
      // Off the SAME analyze() the levels came from — stubs dropped, and a
      // populated map carries no reason.
      factorValues: { greeks: 0.5, mtfTrend: -0.4 },
      factorsReason: null,
    });
  });

  describe('context factors', () => {
    it('anchors the sign to UP, so the SETUP flipping side does not flip every factor', async () => {
      // THE BUG THIS EXISTS FOR. `FactorResult.value` is defined as +1 =
      // supportive of `FactorInput.side`, so one unchanged market read scores
      // +0.5 under a BUY setup and -0.5 under a SELL setup. `contextFactorFlip`
      // fires on a change of SIGN between consecutive ticks — so without this
      // normalisation, the engine merely proposing the other direction would
      // report that every factor flipped at once. That is manufactured signal.
      const same = [
        { name: 'greeks', value: 0.5, isStub: false },
        { name: 'mtfTrend', value: -0.4, isStub: false },
      ];

      const buy = make();
      buy.analyze.mockResolvedValue({
        kind: 'setup',
        side: 'BUY',
        levels: levels(),
        volumeRatio: 2.5,
        contextFactors: same,
      });

      const sell = make();
      // The SELL engine reporting the mirror-image raw values IS the same read
      // of the market: supportive-of-SELL +0.5 means bearish, i.e. -0.5 up.
      sell.analyze.mockResolvedValue({
        kind: 'setup',
        side: 'SELL',
        levels: levels(),
        volumeRatio: 2.5,
        contextFactors: same.map((f) => ({ ...f, value: -f.value })),
      });

      const fromBuy = (await buy.svc.structureFor('SUZLON-EQ', 100.5, 'u1')).factorValues;
      const fromSell = (await sell.svc.structureFor('SUZLON-EQ', 100.5, 'u1')).factorValues;

      expect(fromBuy).toEqual({ greeks: 0.5, mtfTrend: -0.4 });
      // Same numbers, not mirrored ones — no sign flip for the sensor to find.
      expect(fromSell).toEqual(fromBuy);
    });

    it('drops stubs and non-finite values rather than passing them on', async () => {
      const t = make();
      t.analyze.mockResolvedValue({
        kind: 'setup',
        side: 'BUY',
        levels: levels(),
        volumeRatio: 2.5,
        contextFactors: [
          { name: 'greeks', value: 0.5, isStub: false },
          { name: 'fii', value: 0, isStub: true },
          // Math.sign(NaN) is NaN, which is !== every sign — it would read as a
          // flip that never happened. `greeks` can produce one from a malformed
          // option-chain delta.
          { name: 'volatility', value: Number.NaN, isStub: false },
        ],
      });

      const out = await t.svc.structureFor('SUZLON-EQ', 100.5, 'u1');
      expect(out.factorValues).toEqual({ greeks: 0.5 });
      expect(out.factorsReason).toBeNull();
    });

    it('names WHICH emptiness it is, so the packet cannot flatten four causes into one', async () => {
      // A bare `{}` told the agent the macro picture was quiet. These are four
      // different facts and only one of them is about the market.
      const noSetup = make();
      noSetup.analyze.mockResolvedValue({ kind: 'no-setup', levels: null });
      expect((await noSetup.svc.structureFor('SUZLON-EQ', 100.5, 'u1')).factorsReason).toBe(
        FACTORS_NO_SETUP,
      );

      const notScored = make();
      notScored.analyze.mockResolvedValue({
        kind: 'setup',
        side: 'BUY',
        levels: levels(),
        volumeRatio: 2.5,
      });
      expect((await notScored.svc.structureFor('SUZLON-EQ', 100.5, 'u1')).factorsReason).toBe(
        FACTORS_NOT_SCORED,
      );

      const allStubs = make();
      allStubs.analyze.mockResolvedValue({
        kind: 'setup',
        side: 'BUY',
        levels: levels(),
        volumeRatio: 2.5,
        contextFactors: [{ name: 'fii', value: 0, isStub: true }],
      });
      expect((await allStubs.svc.structureFor('SUZLON-EQ', 100.5, 'u1')).factorsReason).toBe(
        FACTORS_ALL_STUBBED,
      );

      const noBook = make();
      noBook.getInstrumentBySymbol.mockResolvedValue(null);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect((await noBook.svc.structureFor('NOPE', 100.5, 'u1')).factorsReason).toBe(
        FACTORS_NO_BOOK,
      );
    });

    it('reports factors even when the price cannot be placed against the levels', async () => {
      // The two are independent readings off one book. Sharing a reason between
      // them would tell the packet the wrong cause for one of the two.
      const t = make();
      const out = await t.svc.structureFor('SUZLON-EQ', null, 'u1');
      expect(out.reason).toBe(LEVEL_BOOK_NO_PRICE);
      expect(out.factorValues).toEqual({ greeks: 0.5, mtfTrend: -0.4 });
      expect(out.factorsReason).toBeNull();
    });
  });

  it('stamps the level book DERIVE time, not the moment it was asked', async () => {
    // The same cached object serves `levelsFor` and `structureFor`, so the two
    // must never report different ages for it — one packet carrying
    // `levelBook.at = T-30s` beside `nearestSupport.at = T` is provenance that
    // contradicts itself about a single read.
    const t = make();
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T06:00:00Z'));
    const book = await t.svc.levelsFor('SUZLON-EQ');

    jest.setSystemTime(new Date('2026-08-14T06:00:30Z'));
    const structure = await t.svc.structureFor('SUZLON-EQ', 100.5);
    jest.useRealTimers();

    expect(t.analyze).toHaveBeenCalledTimes(1); // proves it is the SAME book
    expect(structure.at).toBe('2026-08-14T06:00:00.000Z');
    expect(structure.at).toBe(book?.at);
  });

  it('names the reason as a FAILURE TO LOOK when there is no price to compare', async () => {
    const t = make();
    const result = await t.svc.structureFor('SUZLON-EQ', null);

    expect(result.nearestSupport).toBeNull();
    expect(result.nearestResistance).toBeNull();
    // The volume ratio does not need a price, so it survives.
    expect(result.volumeRatio).toBe(2.5);
    expect(result.reason).toBe(LEVEL_BOOK_NO_PRICE);
    // The distinction the packet depends on: this must not be reported as the
    // market having no level on either side.
    expect(result.reason).not.toBeNull();
    expect(result.reason).toMatch(/FAILURE TO LOOK/);
  });

  it('names a NaN price as a failure to look, exactly as it does a null one', async () => {
    const t = make();
    await expect((await t.svc.structureFor('SUZLON-EQ', Number.NaN)).reason).toBe(
      LEVEL_BOOK_NO_PRICE,
    );
  });

  it('distinguishes an UNBUILT level book from one whose lookup FAILED', async () => {
    // Three causes, three different sentences — the adapter is the only place
    // that can tell them apart, and it used to discard the distinction.
    const unbuilt = make();
    unbuilt.getInstrumentBySymbol.mockResolvedValue(null);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const noInstrument = await unbuilt.svc.structureFor('NOPE', 100.5);
    expect(noInstrument.reason).toBe(LEVEL_BOOK_UNBUILT);

    const nonSetup = make();
    nonSetup.analyze.mockResolvedValue({ kind: 'no-setup' });
    expect((await nonSetup.svc.structureFor('SUZLON-EQ', 100.5)).reason).toBe(LEVEL_BOOK_UNBUILT);

    const threw = make();
    threw.analyze.mockRejectedValue(new Error('candles unavailable'));
    const failed = await threw.svc.structureFor('SUZLON-EQ', 100.5);
    expect(failed.reason).toBe(LEVEL_BOOK_FAILED);
    // No book at all, so there is no derive time to claim — and null makes the
    // packet fall back to its build time rather than invent one.
    expect(failed.at).toBeNull();
    expect(failed.reason).not.toBe(LEVEL_BOOK_UNBUILT);
  });

  it('drops a non-finite volume ratio rather than passing NaN to a sensor', async () => {
    const t = make();
    t.analyze.mockResolvedValue({ kind: 'setup', levels: levels(), volumeRatio: Number.NaN });
    const result = await t.svc.structureFor('SUZLON-EQ', 100.5);
    expect(result.volumeRatio).toBeNull();
  });
});
