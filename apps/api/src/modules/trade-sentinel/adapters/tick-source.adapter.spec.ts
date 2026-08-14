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
  const structureFor = jest
    .fn()
    .mockResolvedValue({ nearestSupport: null, nearestResistance: null, volumeRatio: null });

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
    expect(t.structureFor).toHaveBeenCalledWith('SUZLON-EQ', 105);
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
