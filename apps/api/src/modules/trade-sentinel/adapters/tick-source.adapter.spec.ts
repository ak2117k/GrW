import { Logger } from '@nestjs/common';
import {
  FRESH_NEWS_WINDOW_MS,
  LTP_STALENESS_MS,
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
  // The freshness of `lastLtp`. Fresh by default so every OTHER test in this
  // file keeps testing what it was written to test; the staleness guard has its
  // own block below and overrides this explicitly.
  updatedAt: NOW,
  ...over,
});

/**
 * `withFeed: false` builds the adapter with NO `UserFeedManager`, which is the
 * pre-fix shape: the spot then has only its live-feed tier. Kept as an explicit
 * option rather than the default so a test that wants the blind case has to ask
 * for it — the blind case is what shipped, and it should never be what a new
 * test gets by accident.
 */
function make(opts: { withFeed?: boolean } = {}) {
  const fetchQuote = jest.fn().mockResolvedValue(null);
  const userFeed = opts.withFeed === false ? undefined : ({ fetchQuote } as never);
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
    userFeed,
  );
  return {
    svc,
    findUnique,
    getInstrumentByToken,
    getInstrumentBySymbol,
    getLevels,
    getNewsForSymbol,
    structureFor,
    fetchQuote,
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

      // Filtered by the CONTRACT, not by the word "underlying". The constructor
      // also warns about the missing feed manager and that line is about the
      // process, not this position — a filter loose enough to catch both counts
      // a once-per-boot line as a once-per-poll one and would fail on a warning
      // that is behaving correctly.
      const hits = warn.mock.calls.filter((c) =>
        String(c[0]).includes('NIFTY28AUG2524000CE'),
      );
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

      // The quote tier is wired but returns nothing here, so the stale book has
      // nowhere to fall through TO — which is what makes this assert about the
      // staleness rule rather than about the quote.
      const tick = await t.svc.tickFor('t1');
      expect(tick.underlyingLtp).toBeNull();
      // No reading, so no read time to claim for one.
      expect(tick.underlyingLtpAt).toBeNull();
    });

    /**
     * THE BUG THIS BLOCK EXISTS FOR, and it is the one that made the sentinel
     * useless on every position the user actually held.
     *
     * `spotFor` was a synchronous peek at `levelBooks.getLevels(token)` — a map
     * populated only for tokens the live feed has seeded. That universe is fixed
     * (indices, five major stocks, five commodities), so for a real position the
     * spot was null PERMANENTLY: not overnight, not on a quiet symbol, but at
     * 11:00 on a live trading day. One null then gated four blocks — both nearest
     * levels, `levelBreak` and the OI walls — because each is on the underlying's
     * scale and correctly refuses to compare against a premium.
     */
    describe('the broker-quote tier', () => {
      it('quotes the underlying when it is not on the live feed', async () => {
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue(null); // never seeded — the ordinary case
        t.fetchQuote.mockResolvedValue({ ltp: 24010 });

        const tick = await t.svc.tickFor('t1');

        expect(tick.underlyingLtp).toBe(24010);
        // The CASH token on NSE — not the derivative's own token or exchange,
        // which the broker would resolve to nothing.
        expect(t.fetchQuote).toHaveBeenCalledWith('u1', '26000', 'NSE');
        // Provenance must say which tier, because a REST snapshot and a live
        // print are not the same evidence.
        expect(tick.underlyingLtpSource).toMatch(/quote/i);
        expect(tick.underlyingLtpReason).toBeNull();
      });

      it('falls through to a quote when the live book is STALE', async () => {
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        // A frozen book must not be served, but it must not end the search
        // either — a fresh quote is strictly better than the absence.
        t.getLevels.mockReturnValue({
          spot: 23000,
          lastTickAt: new Date(NOW.getTime() - SPOT_STALENESS_MS - 1),
        });
        t.fetchQuote.mockResolvedValue({ ltp: 24010 });

        const tick = await t.svc.tickFor('t1');
        expect(tick.underlyingLtp).toBe(24010);
        expect(tick.underlyingLtpSource).toMatch(/quote/i);
      });

      it('prefers a FRESH live tick over a quote, and spends no broker call', async () => {
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: new Date(NOW.getTime() - 1000) });

        const tick = await t.svc.tickFor('t1');
        expect(tick.underlyingLtp).toBe(24010);
        expect(tick.underlyingLtpSource).toMatch(/live feed/i);
        expect(t.fetchQuote).not.toHaveBeenCalled();
      });

      it('states that BOTH tiers were tried when neither produces a price', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue(null);
        t.fetchQuote.mockRejectedValue(new Error('broker said no'));

        const tick = await t.svc.tickFor('t1');

        expect(tick.underlyingLtp).toBeNull();
        // "We never asked" and "we asked and were refused" are different facts
        // about a position with money on it, and the packet persists this
        // sentence verbatim for replay.
        expect(tick.underlyingLtpReason).toMatch(/live feed/i);
        expect(tick.underlyingLtpReason).toMatch(/quote/i);
        expect(tick.underlyingLtpReason).toMatch(/FAILURE TO LOOK/i);
      });

      it('says the quote was NOT ATTEMPTED when no feed manager is wired', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const t = make({ withFeed: false });
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue(null);

        const tick = await t.svc.tickFor('t1');
        expect(tick.underlyingLtp).toBeNull();
        // An unwired dependency is OUR failure and must not be reported in
        // wording that suggests the broker declined.
        expect(tick.underlyingLtpReason).toMatch(/not attempted/i);
      });

      it('reuses one quote across contracts sharing an underlying', async () => {
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue(null);
        t.fetchQuote.mockResolvedValue({ ltp: 24010 });

        const first = await t.svc.tickFor('t1');
        const second = await t.svc.tickFor('t1');

        // A straddle is two positions on one spot; it must not be two calls.
        expect(t.fetchQuote).toHaveBeenCalledTimes(1);
        // And the cached reading keeps the ORIGINAL capture time — a cache that
        // refreshes the timestamp without refreshing the price is claiming a
        // read that never happened.
        expect(second.underlyingLtpAt).toBe(first.underlyingLtpAt);
      });

      it('ignores a non-positive quote rather than treating 0 as a price', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const t = make();
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.getInstrumentBySymbol.mockResolvedValue({ token: '26000' });
        t.getLevels.mockReturnValue(null);
        // Angel returns 0 for an unentitled or halted instrument. A zero spot
        // would put every support "above" price and read as a total collapse.
        t.fetchQuote.mockResolvedValue({ ltp: 0 });

        const tick = await t.svc.tickFor('t1');
        expect(tick.underlyingLtp).toBeNull();
      });
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

/**
 * A price that is PRESENT but OLD — the more dangerous of the two failures,
 * because nothing about it looks wrong.
 *
 * Found live on `KEI29SEP265800CE`: `lastLtp` 269.95 stamped 14:10 the previous
 * day, twenty-one hours cold, while the cash trackers beside it updated that
 * morning. The feed's primary slot pool (30) is exhausted by the default
 * universe before the tracker poller subscribes any open position, so the one
 * F&O contract in the book got no ticks at all. The number was finite and
 * positive, so gross P&L, the charges, the green floor and every tripwire would
 * have been computed from it and reported as the market NOW.
 */
describe('SentinelTickSource — a stale price is refused, not judged', () => {
  // The guard compares against `Date.now()`, so these ages are only meaningful
  // with the clock pinned to NOW — the same fixture the rest of the file uses.
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('refuses a price older than the bound', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(
      row({ updatedAt: new Date(NOW.getTime() - LTP_STALENESS_MS - 1) }),
    );
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/REFUSING to judge/i);
  });

  it('names the symbol and the age, so the log identifies the unfed token', async () => {
    const t = make();
    t.findUnique.mockResolvedValue(
      row({ symbol: 'KEI29SEP265800CE', updatedAt: new Date(NOW.getTime() - 21 * 3600_000) }),
    );
    // The cycle catches per position and logs the cause; a bare "stale" would
    // not tell anyone WHICH contract stopped being fed, which is the one fact
    // needed to act on it.
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/KEI29SEP265800CE/);
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/1260 minutes old/);
  });

  it('accepts a price right at the bound', async () => {
    // Strictly greater-than, so an exactly-at-bound tick is still judged. The
    // sweep is 4s and applyTick debounces; refusing on equality would drop a
    // healthy tracker on a rounding edge.
    const t = make();
    t.findUnique.mockResolvedValue(row({ updatedAt: new Date(NOW.getTime() - LTP_STALENESS_MS) }));
    await expect(t.svc.tickFor('t1')).resolves.toMatchObject({ ltp: 105 });
  });

  it('still refuses a MISSING price with its own distinct wording', async () => {
    // Absent and stale are different faults with different remedies — "never
    // ticked" points at reconcile, "stale" points at the subscription pool.
    const t = make();
    t.findUnique.mockResolvedValue(row({ lastLtp: null }));
    await expect(t.svc.tickFor('t1')).rejects.toThrow(/no live price/i);
  });
});
