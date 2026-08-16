import { Logger } from '@nestjs/common';
import {
  FRESH_NEWS_WINDOW_MS,
  SPOT_STALENESS_MS,
  SentinelTickSource,
  segmentFor,
  sideFor,
} from './tick-source.adapter';

const NOW = new Date('2026-08-14T06:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
  // The level book is fetched over THIS user's own Angel session — there is no
  // shared feed account, so a tick that loses the userId gets an empty book.
  userId: 'u1',
  symbol: 'SUZLON-EQ',
  exchange: 'NSE',
  token: '12345',
  kind: 'POSITION',
  entryPrice: 100,
  qty: 10,
  entryTime: new Date('2026-08-14T04:00:00Z'),
  holdingHigh: 110,
  holdingLow: 98,
  lastLtp: 105,
  ...over,
});

function make() {
  const findUnique = jest.fn().mockResolvedValue(row());
  const getInstrumentByToken = jest.fn().mockResolvedValue(null);
  const getInstrumentBySymbol = jest.fn().mockResolvedValue(null);
  const getLevels = jest.fn().mockReturnValue(null);
  const getNewsForSymbol = jest.fn().mockResolvedValue([]);
  const structureFor = jest.fn().mockResolvedValue({
    nearestSupport: null,
    nearestResistance: null,
    volumeRatio: null,
    // The adapter now reports WHY the levels are null and WHEN the book behind
    // them was derived; the tick carries both through to the packet unchanged.
    reason: 'no level book could be built for this symbol',
    at: '2026-08-14T06:00:00.000Z',
    source: 'signal-generator.analyze (15m level book)',
  });

  const svc = new SentinelTickSource(
    { tradeTracker: { findUnique } } as never,
    { getInstrumentByToken, getInstrumentBySymbol } as never,
    { getLevels } as never,
    { getNewsForSymbol } as never,
    { structureFor } as never,
  );
  return {
    svc,
    findUnique,
    getInstrumentByToken,
    getInstrumentBySymbol,
    getLevels,
    getNewsForSymbol,
    structureFor,
  };
}

describe('segmentFor', () => {
  it('reads an option off its CE/PE suffix, never off the exchange alone', () => {
    expect(segmentFor({ exchange: 'NFO', symbol: 'NIFTY28AUG2524000CE', kind: 'POSITION' })).toBe(
      'OPT',
    );
    expect(segmentFor({ exchange: 'NFO', symbol: 'NIFTY28AUG2524000PE', kind: 'POSITION' })).toBe(
      'OPT',
    );
  });

  it('reads a future off its FUT suffix', () => {
    expect(segmentFor({ exchange: 'NFO', symbol: 'RELIANCE28AUG25FUT', kind: 'POSITION' })).toBe(
      'FUT',
    );
  });

  it('splits cash by kind — a holding is delivery, a position is intraday', () => {
    expect(segmentFor({ exchange: 'NSE', symbol: 'SUZLON-EQ', kind: 'HOLDING' })).toBe(
      'EQ_DELIVERY',
    );
    expect(segmentFor({ exchange: 'NSE', symbol: 'SUZLON-EQ', kind: 'POSITION' })).toBe(
      'EQ_INTRADAY',
    );
  });

  it('falls back to OPT on a derivative exchange it cannot parse', () => {
    // OPT carries the highest STT and txn rates, so the floor sits HIGHER and
    // arms later. Guessing the cheap schedule would arm a floor on a trade that
    // has not actually cleared its charges.
    expect(segmentFor({ exchange: 'MCX', symbol: 'CRUDEOILM', kind: 'POSITION' })).toBe('OPT');
  });

  it('is case-insensitive on both fields', () => {
    expect(segmentFor({ exchange: 'nfo', symbol: 'nifty28aug2524000ce', kind: 'POSITION' })).toBe(
      'OPT',
    );
  });
});

describe('sideFor', () => {
  it('reads a short off the broker’s negative net quantity', () => {
    expect(sideFor(-10)).toBe('SHORT');
    expect(sideFor(10)).toBe('LONG');
    // Zero-qty rows never reach here (the tracker closes them), and LONG is the
    // side whose charge schedule is the more conservative of the two.
    expect(sideFor(0)).toBe('LONG');
  });
});

describe('SentinelTickSource', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('sets underlyingLtp to ltp on a cash position, never null', async () => {
    const t = make();
    const tick = await t.svc.tickFor('t1');
    // A null here silences EVERY level-comparing sensor on EVERY equity
    // position, and it looks exactly like "the level was never touched".
    expect(tick.underlyingLtp).toBe(105);
    expect(tick.ltp).toBe(105);
  });

  it('sets underlyingLtp to ltp on a cash HOLDING too', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(row({ kind: 'HOLDING' }));
    const tick = await t.svc.tickFor('t1');
    expect(tick.segment).toBe('EQ_DELIVERY');
    expect(tick.underlyingLtp).toBe(105);
  });

  it('reports a short with a POSITIVE quantity and the SHORT side', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(row({ qty: -10 }));

    const tick = await t.svc.tickFor('t1');

    expect(tick.side).toBe('SHORT');
    // The sign has already been consumed by `side`; the charge model and the
    // P&L both multiply by qty, so a negative here would invert the P&L a
    // second time and report a winning short as a loser.
    expect(tick.qty).toBe(10);
  });

  it('throws a stated cause rather than substituting a price', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(row({ lastLtp: null }));
    // Falling back to entryPrice would report a moving trade as flat, which the
    // agent reads as calm. The cycle catches this per position and logs it.
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/no live price/i);
  });

  it('throws when the tracker has gone', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(null);
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/no longer exists/i);
  });

  it('never lets a NaN price through as a reading', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(row({ lastLtp: Number.NaN }));
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/no live price/i);
  });

  it('counts only headlines inside the fresh window', async () => {
    const t = make();
    t.getNewsForSymbol.mockResolvedValue([
      { publishedAt: new Date(NOW.getTime() - 60_000) },
      { publishedAt: new Date(NOW.getTime() - FRESH_NEWS_WINDOW_MS + 1) },
      { publishedAt: new Date(NOW.getTime() - FRESH_NEWS_WINDOW_MS - 1) },
    ]);

    const tick = await t.svc.tickFor('t1');

    expect(tick.freshNewsCount).toBe(2);
    expect(t.getNewsForSymbol).toHaveBeenCalledWith('SUZLON');
  });

  it('reports a failed news read as NULL, not as zero', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = make();
    t.getNewsForSymbol.mockRejectedValue(new Error('db down'));

    const tick = await t.svc.tickFor('t1');

    // `newsHit` treats a finite count below 1 as "no news" and null as "no
    // reading". Reporting 0 would tell the agent, with provenance, that nothing
    // has been published.
    expect(tick.freshNewsCount).toBeNull();
  });

  it('passes the UNDERLYING price to the level lookup, not the contract price', async () => {
    const t = make();
    await t.svc.tickFor('t1');
    // For cash the tradingsymbol IS the level book's key — the instrument
    // master holds cash equities under exactly this spelling.
    expect(t.structureFor).toHaveBeenCalledWith('SUZLON-EQ', 105, 'u1');
  });

  it('carries the level book’s answer straight through', async () => {
    const t = make();
    t.structureFor.mockResolvedValue({
      nearestSupport: 102,
      nearestResistance: 108,
      volumeRatio: 2.4,
    });

    const tick = await t.svc.tickFor('t1');

    expect(tick.nearestSupport).toBe(102);
    expect(tick.nearestResistance).toBe(108);
    expect(tick.volumeRatio).toBe(2.4);
  });

  it('carries the level book’s REASON and derive time, not just its numbers', async () => {
    const t = make();
    t.structureFor.mockResolvedValue({
      nearestSupport: null,
      nearestResistance: null,
      volumeRatio: null,
      reason: 'the level-book lookup FAILED for this symbol',
      at: '2026-08-14T05:59:00.000Z',
      source: 'signal-generator.analyze (15m level book)',
    });

    const tick = await t.svc.tickFor('t1');

    // Dropping any of these three is how the packet came to assert "no support
    // level below this price" about a book it never managed to build, and to
    // stamp a 60s-old cached reading with the packet's own build time.
    expect(tick.structureReason).toBe('the level-book lookup FAILED for this symbol');
    expect(tick.structureAt).toBe('2026-08-14T05:59:00.000Z');
    expect(tick.structureSource).toBe('signal-generator.analyze (15m level book)');
  });

  it('carries a null reason through, so a real finding keeps its own wording', async () => {
    const t = make();
    t.structureFor.mockResolvedValue({
      nearestSupport: 102,
      nearestResistance: null,
      volumeRatio: 2.4,
      reason: null,
      at: '2026-08-14T05:59:00.000Z',
      source: 'signal-generator.analyze (15m level book)',
    });

    expect((await t.svc.tickFor('t1')).structureReason).toBeNull();
  });

  it('has no expiry for cash, so the OI capture is correctly skipped', async () => {
    const t = make();
    await expect((await t.svc.tickFor('t1')).expiry).toBeNull();
    expect(t.getInstrumentByToken).not.toHaveBeenCalled();
  });

  describe('derivatives', () => {
    const option = () =>
      row({ symbol: 'NIFTY28AUG2524000CE', exchange: 'NFO', token: '99', lastLtp: 120 });

    it('resolves the expiry from the instrument master as YYYY-MM-DD', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({
        name: 'NIFTY',
        expiry: new Date('2026-08-28T00:00:00Z'),
      });

      const tick = await t.svc.tickFor('t1');

      expect(tick.segment).toBe('OPT');
      expect(tick.expiry).toBe('2026-08-28');
    });

    it('reads the expiry date in IST, so it is not a day early east of UTC', async () => {
      // The instrument master builds expiry at LOCAL midnight, so on an IST host
      // a 28-Aug contract IS this instant. `toISOString().slice(0, 10)` gives
      // '2026-08-27' for it — correct on a UTC host, wrong on every host that
      // actually runs an Indian market session, and wrong ON EXPIRY DAY, when
      // the agent is told the contract expired yesterday. It is also the
      // OI-snapshot lineage key, so the two spellings orphan the series.
      //
      // Fixed to an ABSOLUTE instant rather than `new Date(2026, 7, 28)`: a
      // local-midnight fixture is the same as UTC midnight on a UTC CI host, so
      // the assertion would pass vacuously exactly where the bug is invisible.
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({
        name: 'NIFTY',
        expiry: new Date('2026-08-27T18:30:00.000Z'), // = 2026-08-28 00:00 IST
      });

      const tick = await t.svc.tickFor('t1');

      expect(tick.expiry).toBe('2026-08-28');
      expect(tick.expiry).not.toBe(
        new Date('2026-08-27T18:30:00.000Z').toISOString().slice(0, 10),
      );
    });

    it('does not roll the expiry FORWARD for a late-IST instant either', async () => {
      // The mirror mutant: an IST-evening instant must stay on its own IST day.
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({
        name: 'NIFTY',
        expiry: new Date('2026-08-28T18:29:00.000Z'), // = 2026-08-28 23:59 IST
      });

      expect((await t.svc.tickFor('t1')).expiry).toBe('2026-08-28');
    });

    it('looks the level book up by the UNDERLYING NAME, not the tradingsymbol', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      await t.svc.tickFor('t1');

      // `getInstrumentBySymbol` filters {symbol, exchange} EXACTLY, and only
      // cash equities are in that table — so an NFO tradingsymbol matches
      // nothing, permanently, however good the spot is.
      expect(t.structureFor).toHaveBeenCalledWith('NIFTY', 24010, 'u1');
      expect(t.structureFor).not.toHaveBeenCalledWith(
        'NIFTY28AUG2524000CE',
        expect.anything(),
      );
    });

    it('looks the NEWS up by the underlying name too', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      await t.svc.tickFor('t1');

      // `relatedSymbols` holds base symbols; a tradingsymbol never matches and
      // `newsHit` would be dark on every derivative.
      expect(t.getNewsForSymbol).toHaveBeenCalledWith('NIFTY');
    });

    it('resolves the underlying ONCE and uses the same one for spot, levels and news', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      await t.svc.tickFor('t1');

      // All three must be talking about the same underlying, or the packet
      // describes one instrument with another's evidence.
      expect(t.getLevels).toHaveBeenCalledWith('26000');
      expect(t.structureFor.mock.calls[0][0]).toBe('NIFTY');
      expect(t.getNewsForSymbol.mock.calls[0][0]).toBe('NIFTY');
    });

    it('keeps the level book and the news when only the SPOT cannot be resolved', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      // The NAME resolved; the cash/index instrument row did not.
      t.getInstrumentBySymbol.mockResolvedValue(null);

      const tick = await t.svc.tickFor('t1');

      // Only the spot needs the token. Collapsing the two would take the level
      // book and the news down with it for no reason.
      expect(tick.underlyingLtp).toBeNull();
      expect(t.structureFor).toHaveBeenCalledWith('NIFTY', null, 'u1');
      expect(t.getNewsForSymbol).toHaveBeenCalledWith('NIFTY');
    });

    it('asks NEITHER adapter anything when the underlying name is unknown', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue(null);

      const tick = await t.svc.tickFor('t1');

      // Falling back to the tradingsymbol would restore exactly the silent
      // permanent miss this fixes, dressed up as an attempt.
      expect(t.structureFor).not.toHaveBeenCalled();
      expect(t.getNewsForSymbol).not.toHaveBeenCalled();
      expect(tick.nearestSupport).toBeNull();
      expect(tick.volumeRatio).toBeNull();
      // Null, not 0: nobody read the news, as opposed to nothing being published.
      expect(tick.freshNewsCount).toBeNull();
    });

    it('warns ONCE per contract rather than on every 30-second poll', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue(null);

      await t.svc.tickFor('t1');
      await t.svc.tickFor('t1');
      await t.svc.tickFor('t1');

      const hits = warn.mock.calls.filter((c) => /underlying/i.test(String(c[0])));
      expect(hits).toHaveLength(1);
      // And it must say what goes dark, or the line cannot be acted on.
      expect(String(hits[0][0])).toMatch(/level book/i);
    });

    it('takes the underlying spot from the live level book', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: new Date(NOW.getTime() - 1000) });

      const tick = await t.svc.tickFor('t1');

      expect(tick.ltp).toBe(120);
      // The premium and the spot are on different scales, and only the spot is
      // comparable against a level or a strike.
      expect(tick.underlyingLtp).toBe(24010);
      expect(t.getLevels).toHaveBeenCalledWith('26000');
      // The TICK's time, not this instant. The spot may be up to
      // SPOT_STALENESS_MS old and still be served, so stamping "now" on it tells
      // the agent a minute-old price was read at packet build.
      expect(tick.underlyingLtpAt).toBe(new Date(NOW.getTime() - 1000).toISOString());
      expect(tick.underlyingLtpAt).not.toBe(NOW.toISOString());
    });

    it('drops a STALE spot rather than comparing levels against a frozen number', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({
        spot: 24010,
        lastTickAt: new Date(NOW.getTime() - SPOT_STALENESS_MS - 1),
      });

      const tick = await t.svc.tickFor('t1');
      expect(tick.underlyingLtp).toBeNull();
      // No reading, so no read time to claim for one.
      expect(tick.underlyingLtpAt).toBeNull();
    });

    it('reports no spot rather than falling back to the premium', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue(null);

      const tick = await t.svc.tickFor('t1');

      // Substituting 120 for the spot would compare a premium against a 24000
      // strike and read as a permanent breach on every tick.
      expect(tick.underlyingLtp).toBeNull();
      expect(tick.ltp).toBe(120);
    });

    it('does not cache a FAILED underlying lookup', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      await expect((await t.svc.tickFor('t1')).underlyingLtp).toBeNull();
      // Caching a failure would silence the level sensors on this position for
      // the rest of the process's life.
      await expect((await t.svc.tickFor('t1')).underlyingLtp).toBe(24010);
    });

    it('memoises a SUCCESSFUL resolution — the master does not change intraday', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      await t.svc.tickFor('t1');
      const after = t.getInstrumentBySymbol.mock.calls.length;
      await t.svc.tickFor('t1');

      expect(t.getInstrumentBySymbol.mock.calls.length).toBe(after);
    });
  });
});
