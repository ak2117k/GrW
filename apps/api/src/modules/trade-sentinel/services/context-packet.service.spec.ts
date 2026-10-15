import { computeGreenFloor } from '../charges';
import { makeSentinelClock } from '../overnight/overnight-calendar';
import {
  ContextPacketService,
  FLOOR_CLAMP_TOLERANCE_RUPEES,
  absent,
  clampFloorTowardLtp,
  istWallClock,
  minutesToSessionClose,
  present,
  type StoredThesis,
  type TickSnapshot,
} from './context-packet.service';

/**
 * What `SentinelChartContextAdapter.SENTINEL_LEVEL_SOURCE` evaluates to, written
 * as a literal rather than imported: importing the adapter would drag
 * `SignalGeneratorService` and its whole graph into a unit spec for a service
 * that never touches it. The point being tested here is that the packet uses
 * WHATEVER the tick carried, not this particular string.
 */
const LEVEL_SOURCE = 'signal-generator.analyze (15m level book)';

describe('block helpers', () => {
  it('marks a missing block with a reason, never a zero', () => {
    const block = absent('fii factor is a stub');
    expect(block).toEqual({ available: false, reason: 'fii factor is a stub' });
    expect((block as any).value).toBeUndefined();
  });

  it('stamps a present block with its source and time', () => {
    const block = present(42, 'oi-wall.service', '2026-08-14T10:00:00.000Z');
    expect(block).toEqual({
      available: true,
      value: 42,
      source: 'oi-wall.service',
      at: '2026-08-14T10:00:00.000Z',
    });
  });
});

describe('clampFloorTowardLtp', () => {
  it('closes a one-tick rounding artifact onto the market', () => {
    // The only defect the clamp exists for: the floor is a single tick beyond ltp.
    expect(clampFloorTowardLtp(102.01, 102.0, 'LONG')).toBe(102.0);
    expect(clampFloorTowardLtp(97.99, 98.0, 'SHORT')).toBe(98.0);
  });

  it('reports real distance as real distance, however wrong-sided', () => {
    // A LONG ₹12 under its floor is NOT sitting on its floor. Clamping here is
    // the C1 lie: a wrong number with provenance, persisted for replay.
    expect(clampFloorTowardLtp(102.01, 90, 'LONG')).toBe(102.01);
    expect(clampFloorTowardLtp(97.99, 110, 'SHORT')).toBe(97.99);
    // ...including the armed-then-pulled-back case, where the gap IS the signal.
    expect(clampFloorTowardLtp(102.01, 100.5, 'LONG')).toBe(102.01);
  });

  it('clamps up to the tolerance and not one paisa beyond it', () => {
    const ltp = 100;
    const inside = ltp + FLOOR_CLAMP_TOLERANCE_RUPEES;
    const outside = ltp + FLOOR_CLAMP_TOLERANCE_RUPEES + 0.01;
    expect(clampFloorTowardLtp(inside, ltp, 'LONG')).toBe(ltp);
    expect(clampFloorTowardLtp(outside, ltp, 'LONG')).toBeCloseTo(outside, 10);
  });

  it('leaves a floor already on the market’s side untouched', () => {
    expect(clampFloorTowardLtp(101.6, 120, 'LONG')).toBe(101.6);
    expect(clampFloorTowardLtp(98.4, 90, 'SHORT')).toBe(98.4);
  });

  it('reports no floor rather than a non-finite one', () => {
    expect(clampFloorTowardLtp(null, 120, 'LONG')).toBeNull();
    expect(clampFloorTowardLtp(NaN, 120, 'LONG')).toBeNull();
    expect(clampFloorTowardLtp(Infinity, 120, 'LONG')).toBeNull();
  });
});

describe('IST session clock', () => {
  it('renders the IST wall clock, not the UTC instant under an IST label', () => {
    // 10:00:00 UTC is 15:30:00 IST on the same date.
    expect(istWallClock(new Date('2026-08-14T10:00:00Z'))).toBe('2026-08-14 15:30:00 IST');
    // An instant that is still the previous day in UTC but already IST tomorrow.
    expect(istWallClock(new Date('2026-08-13T19:00:00Z'))).toBe('2026-08-14 00:30:00 IST');
  });

  it('counts the minutes left in the session so the agent never does timezone math', () => {
    // Friday 2026-08-14, 09:15 IST = 03:45 UTC — a full session ahead.
    const open = minutesToSessionClose(new Date('2026-08-14T03:45:00Z'));
    expect(open.available).toBe(true);
    if (open.available) expect(open.value).toBe(375); // 09:15 -> 15:30

    const late = minutesToSessionClose(new Date('2026-08-14T09:45:00Z')); // 15:15 IST
    expect(late.available).toBe(true);
    if (late.available) expect(late.value).toBe(15);
  });

  it('states why there is no countdown rather than reporting zero', () => {
    const afterClose = minutesToSessionClose(new Date('2026-08-14T10:30:00Z')); // 16:00 IST
    expect(afterClose.available).toBe(false);
    if (!afterClose.available) expect(afterClose.reason).toMatch(/closed/i);

    const saturday = minutesToSessionClose(new Date('2026-08-15T05:00:00Z')); // Sat 10:30 IST
    expect(saturday.available).toBe(false);
    if (!saturday.available) expect(saturday.reason).toMatch(/weekend|trading day/i);
  });
});

describe('minutesToSessionClose — the MCX late close and holidays', () => {
  // Monday 2026-11-02 23:40 IST = 18:10 UTC: the first day of the 2026-27
  // late-close season, when MCX trades until 23:55.
  const MON_2340_IST = new Date('2026-11-02T18:10:00Z');
  const SEASON = '2026-11-02:2027-03-08';
  const saved = process.env.HUB_MCX_LATE_CLOSE;
  afterEach(() => {
    if (saved === undefined) delete process.env.HUB_MCX_LATE_CLOSE;
    else process.env.HUB_MCX_LATE_CLOSE = saved;
  });

  it('counts down to 23:55 for MCX inside the late-close season', () => {
    const block = minutesToSessionClose(MON_2340_IST, 'MCX', makeSentinelClock(SEASON));
    expect(block.available).toBe(true);
    if (block.available) {
      expect(block.value).toBe(15);
      expect(block.source).toMatch(/23:55/);
    }
  });

  it('reads the season from HUB_MCX_LATE_CLOSE when no clock is passed (the live path)', () => {
    process.env.HUB_MCX_LATE_CLOSE = SEASON;
    const block = minutesToSessionClose(MON_2340_IST, 'MCX');
    expect(block.available).toBe(true);
    if (block.available) expect(block.value).toBe(15);
  });

  it('is closed at 23:40 for MCX outside the season — 23:30 is the standard close', () => {
    delete process.env.HUB_MCX_LATE_CLOSE;
    const block = minutesToSessionClose(MON_2340_IST, 'MCX');
    expect(block.available).toBe(false);
    if (!block.available) expect(block.reason).toMatch(/closed \(23:30/);
  });

  it('states an exchange holiday instead of counting down to a close that will not come', () => {
    // Friday 2026-10-02, Gandhi Jayanti, 10:00 IST.
    const block = minutesToSessionClose(new Date('2026-10-02T04:30:00Z'), 'NSE');
    expect(block.available).toBe(false);
    if (!block.available) expect(block.reason).toMatch(/holiday/i);
  });
});

describe('ContextPacketService', () => {
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const levelsFor = jest.fn().mockResolvedValue(null);
  const recentFor = jest.fn().mockResolvedValue(null);

  const svc = new ContextPacketService(
    { recentForTracker } as any,
    { levelsFor } as any,
    { recentFor } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    recentForTracker.mockResolvedValue([]);
    levelsFor.mockResolvedValue(null);
    recentFor.mockResolvedValue(null);
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  });

  const entry = {
    // The packet counts down to THIS venue's close; NSE keeps the 15:30
    // behaviour these assertions were written against.
    exchange: 'NSE',
    userId: 'u1',
    trackerId: 't1',
    symbol: 'INFY',
    kind: 'POSITION' as const,
    ownership: 'SENTINEL' as const,
    watched: true,
    reason: '',
  };

  const tick: TickSnapshot = {
    segment: 'EQ_INTRADAY',
    side: 'LONG',
    // Cash: the tradingsymbol IS the level book's key.
    structureSymbol: 'INFY',
    entryPrice: 100,
    qty: 100,
    ltp: 120,
    underlyingLtp: 120,
    underlyingLtpAt: null,
    underlyingLtpSource: 'market-data (underlying spot — live feed tick)',
    underlyingLtpReason: null,
    nearestSupport: null,
    nearestResistance: null,
    structureReason: null,
    structureAt: null,
    structureSource: LEVEL_SOURCE,
    holdingHigh: 125,
    holdingLow: 98,
    entryTime: new Date('2026-08-14T04:00:00Z'),
    expiry: null,
    volumeRatio: null,
    freshNewsCount: null,
    factorValues: {},
    factorsReason: null,
  oiWallNow: null,
  oiWallPrev: null,
  oiWallsAt: null,
  greenFloorArmedLatched: false,
  };

  /** The floor solved for this fixture, independent of the ltp being tested. */
  const floorFor = (t: TickSnapshot) =>
    computeGreenFloor({
      segment: t.segment,
      entryPrice: t.entryPrice,
      ltp: t.ltp,
      qty: t.qty,
      side: t.side,
    }).floorPrice as number;

  it('marks the stubbed sector factor unavailable, and fiiDii / globalCues as the cues switch — not a stub', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.macro.sector.available).toBe(false);
    if (!packet.macro.sector.available) expect(packet.macro.sector.reason).toMatch(/stub/i);
    // fiiDii and globalCues are not stubs: they are the market-cues module, switched off.
    for (const block of [packet.macro.fiiDii, packet.macro.globalCues]) {
      expect(block.available).toBe(false);
      if (!block.available) {
        expect(block.reason).toMatch(/MARKET_CUES_ENABLED/);
        expect(block.reason).not.toMatch(/stub/i);
      }
    }
    // FII/DII is post-close data; the agent must never treat it as intraday.
    expect(packet.macro.fiiDii.available).toBe(false);
    if (!packet.macro.fiiDii.available) {
      expect(packet.macro.fiiDii.reason).toMatch(/post-close/i);
    }
  });

  it('with market cues switched off, macro is EXACTLY the pre-cues (v2) packet', async () => {
    const off = { enabled: false } as any;
    const s = new ContextPacketService({ recentForTracker } as any, { levelsFor } as any, { recentFor } as any, { peek: () => off } as any);
    const withOff = await s.build(entry, tick, null);
    const without = await svc.build(entry, tick, null);
    expect(withOff.macro).toEqual(without.macro);
    expect(without.macro.fiiDii).toEqual({
      available: false,
      reason:
        'market cues are not switched on (MARKET_CUES_ENABLED is not true, or the market-cues service is not wired into ' +
        'this process), so no FII/DII figure is held. Note FII/DII is published post-close and can never be an intraday trigger.',
    });
    expect(without.macro.globalCues).toEqual({
      available: false,
      reason:
        'market cues are not switched on (MARKET_CUES_ENABLED is not true, or the market-cues service is not wired into ' +
        'this process), so no US index, US index future, GIFT Nifty, commodity benchmark or USD/INR reading is held',
    });
  });

  describe('macro from the market-cues cache (read only, no I/O)', () => {
    const rec = (values: unknown, over: Record<string, unknown> = {}) => ({
      values,
      sourceTime: '2026-10-09T21:15:59.000Z',
      fetchedAt: '2026-10-12T02:55:00.000Z',
      basis: 'previous US session close',
      source: 'Yahoo Finance v8 chart',
      status: 'ok',
      ...over,
    });
    const none = { values: null, sourceTime: null, fetchedAt: null, basis: '', source: '', status: 'unavailable', reason: 'not fetched yet in this process' };
    const snapshot = {
      enabled: true,
      us: {
        nasdaq: rec({ symbol: '^IXIC', last: 27366.17, previousClose: 27193.34, change: 172.83, changePercent: 0.64 }),
        sp500: none,
        dow: none,
        nasdaqFutures: rec({ symbol: 'NQ=F', last: 31108.75, previousClose: 30969.5, change: 139.25, changePercent: 0.45 }, { status: 'stale', reason: 'quote is 600 minutes old' }),
        sp500Futures: none,
      },
      fiiDii: rec(
        { date: '2026-10-09', fii: { buy: 1, sell: 2, net: -1 }, dii: { buy: 3, sell: 1, net: 2 }, unit: '₹ crore' },
        { sourceTime: '2026-10-09', source: 'NSE fiidiiTradeReact', basis: 'session date' },
      ),
      fiiOi: none,
      gift: none,
      preOpen: none,
    };
    const giftRec = rec(
      {
        gift: { price: 22650, expiry: '2026-11-23', at: '2026-10-27T18:05:00.000Z', dayChange: null },
        niftyFuture: { close: 22612.6, expiry: '2026-10-27', sessionDate: '2026-10-27', closedAt: null },
        gap: null,
        gapPercent: null,
        expiryMatches: false,
        comparison: 'futures-vs-futures gap',
      },
      { status: 'stale', reason: 'expiry mismatch (GIFT 2026-11-23 vs NSE 2026-10-27)', sourceTime: '2026-10-27T18:05:00.000Z' },
    );

    it('globalCues.giftNifty carries both expiries and expiryMatches', async () => {
      const s = new ContextPacketService({ recentForTracker } as any, { levelsFor } as any, { recentFor } as any, { peek: () => ({ ...snapshot, gift: giftRec }) } as any);
      const packet = await s.build(entry, tick, null);
      const g = packet.macro.globalCues.available ? (packet.macro.globalCues.value as Record<string, any>).giftNifty : null;
      expect(g.value).toEqual(
        expect.objectContaining({ giftExpiry: '2026-11-23', niftyFutureExpiry: '2026-10-27', expiryMatches: false, gap: null, status: 'stale', note: expect.stringMatching(/expiry mismatch/) }),
      );
    });

    it('fiiDii and globalCues carry the cached readings, each with its own source time and status', async () => {
      const peek = jest.fn().mockReturnValue(snapshot);
      const s = new ContextPacketService({ recentForTracker } as any, { levelsFor } as any, { recentFor } as any, { peek } as any);
      const packet = await s.build(entry, tick, null);
      expect(peek).toHaveBeenCalledTimes(1);
      expect(packet.macro.fiiDii).toEqual(
        expect.objectContaining({
          available: true,
          at: '2026-10-09',
          value: expect.objectContaining({ session: '2026-10-09', fii: { buy: 1, sell: 2, net: -1 }, status: 'ok' }),
        }),
      );
      expect(packet.macro.globalCues.available).toBe(true);
      const g = packet.macro.globalCues.available ? (packet.macro.globalCues.value as Record<string, any>) : {};
      expect(g.nasdaq).toEqual(expect.objectContaining({ available: true, at: '2026-10-09T21:15:59.000Z', value: expect.objectContaining({ last: 27366.17, status: 'ok' }) }));
      expect(g.nasdaqFutures.value).toEqual(expect.objectContaining({ status: 'stale', note: expect.stringMatching(/600 minutes/) }));
      expect(g.sp500).toEqual({ available: false, reason: expect.stringMatching(/not fetched/) });
      expect(g.giftNifty).toEqual({ available: false, reason: expect.stringMatching(/not fetched/) });
      expect(packet.macro.sector.available).toBe(false);
    });

    it('an enabled cache holding nothing says why, never a zero', async () => {
      const empty = {
        ...snapshot,
        us: Object.fromEntries(Object.keys(snapshot.us).map((k) => [k, none])),
        fiiDii: none,
      };
      const s = new ContextPacketService({ recentForTracker } as any, { levelsFor } as any, { recentFor } as any, { peek: () => empty } as any);
      const packet = await s.build(entry, tick, null);
      expect(packet.macro.fiiDii).toEqual({ available: false, reason: expect.stringMatching(/not fetched yet/) });
      expect(packet.macro.globalCues).toEqual({ available: false, reason: expect.stringMatching(/not fetched yet/) });
    });
  });

  it('always includes the money block with net P&L and the green floor', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.money.grossPnl).toBe((120 - 100) * 100);
    expect(packet.money.charges).toBeGreaterThan(0);
    expect(packet.money.netPnl).toBeLessThan((120 - 100) * 100); // charges subtracted
    expect(packet.money.netPnl).toBe(packet.money.grossPnl - packet.money.charges);
    expect(packet.money.greenFloorPrice).not.toBeNull();
    expect(packet.money.greenFloorArmed).toBe(true);
    expect(packet.money.mfe).toBe(125);
    expect(packet.money.mae).toBe(98);
  });

  it('reports a short’s excursions from the short’s point of view', async () => {
    const packet = await svc.build(entry, { ...tick, side: 'SHORT', ltp: 80 }, null);
    // For a SHORT the best excursion is the LOW and the worst is the HIGH.
    expect(packet.money.mfe).toBe(98);
    expect(packet.money.mae).toBe(125);
    expect(packet.money.grossPnl).toBe((100 - 80) * 100);
  });

  it('never reports a long’s floor a tick above the market at the arming tick', async () => {
    // At ltp 102.00 the solved floor is 102.01 — one tick beyond the market,
    // purely the conservative rounding. THAT is what the clamp is for.
    const armingTick = { ...tick, ltp: 102.0 };
    const raw = floorFor(armingTick);
    expect(raw).toBeGreaterThan(armingTick.ltp); // the artifact is really present
    expect(raw - armingTick.ltp).toBeLessThanOrEqual(FLOOR_CLAMP_TOLERANCE_RUPEES);

    const packet = await svc.build(entry, armingTick, null);
    expect(packet.money.greenFloorPrice).toBe(armingTick.ltp);
  });

  it('never reports a short’s floor a tick below the market at the arming tick', async () => {
    const armingTick = { ...tick, side: 'SHORT' as const, ltp: 98.0 };
    const raw = floorFor(armingTick);
    expect(raw).toBeLessThan(armingTick.ltp);
    expect(armingTick.ltp - raw).toBeLessThanOrEqual(FLOOR_CLAMP_TOLERANCE_RUPEES);

    const packet = await svc.build(entry, armingTick, null);
    expect(packet.money.greenFloorPrice).toBe(armingTick.ltp);
  });

  it('does not collapse a losing position’s floor onto the market', async () => {
    // LONG, entry 100, qty 100, ltp 90: ~₹1050 down, floor ~102.01, unarmed.
    // Reporting greenFloorPrice 90 beside netPnl -1050 would tell the agent it
    // is sitting exactly on its protected floor when it is ₹12 away.
    const red = { ...tick, ltp: 90 };
    const packet = await svc.build(entry, red, null);
    expect(packet.money.netPnl).toBeLessThan(-1000);
    expect(packet.money.greenFloorPrice).toBe(floorFor(red));
    expect(packet.money.greenFloorPrice as number).toBeGreaterThan(red.ltp + 1);
  });

  it('does not collapse an armed-then-pulled-back floor onto the market', async () => {
    // The gap between a latched floor and a pulled-back price IS the signal.
    const pulledBack = { ...tick, ltp: 100.5, greenFloorArmedLatched: true };
    const packet = await svc.build(entry, pulledBack, null);
    expect(packet.money.greenFloorArmed).toBe(true);
    expect(packet.money.greenFloorPrice).toBe(floorFor(pulledBack));
    expect(packet.money.greenFloorPrice as number).toBeGreaterThan(pulledBack.ltp);
  });

  it('keeps the floor armed once latched, even when the tick alone says otherwise', async () => {
    const pulledBack = { ...tick, ltp: 99, greenFloorArmedLatched: true };
    expect(
      computeGreenFloor({
        segment: pulledBack.segment,
        entryPrice: pulledBack.entryPrice,
        ltp: pulledBack.ltp,
        qty: pulledBack.qty,
        side: pulledBack.side,
      }).armed,
    ).toBe(false); // this tick, on its own, is not armed

    const packet = await svc.build(entry, pulledBack, null);
    expect(packet.money.greenFloorArmed).toBe(true);

    const neverArmed = await svc.build(entry, { ...tick, ltp: 99 }, null);
    expect(neverArmed.money.greenFloorArmed).toBe(false);
  });

  it('states plainly when no thesis has been formed yet', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.thesis.available).toBe(false);
    if (!packet.thesis.available) expect(packet.thesis.reason).toMatch(/no thesis/i);
  });

  it('attributes a thesis to the user when the user set it, and copies it', async () => {
    const thesis: StoredThesis = {
      direction: 'UP',
      reason: 'holding above the breakout',
      levelPrice: 100,
      targetPrice: 130,
      invalidation: 95,
      source: 'USER',
    };
    const packet = await svc.build(entry, tick, thesis);
    expect(packet.thesis.available).toBe(true);
    if (packet.thesis.available) {
      expect(packet.thesis.value).toEqual(thesis);
      expect(packet.thesis.source).toMatch(/user/i);
      // Persisted verbatim means persisted immutably: mutating the caller's
      // object must not rewrite what the record says the agent saw.
      thesis.reason = 'rewritten after the fact';
      thesis.targetPrice = 999;
      expect(packet.thesis.value.reason).toBe('holding above the breakout');
      expect(packet.thesis.value.targetPrice).toBe(130);
    }

    const inferred = await svc.build(entry, tick, { ...thesis, source: 'AGENT' });
    expect(inferred.thesis.available).toBe(true);
    if (inferred.thesis.available) expect(inferred.thesis.source).not.toMatch(/user/i);
  });

  it('refuses to ship a non-finite volume reading as a real one', async () => {
    for (const bad of [NaN, Infinity, null]) {
      const packet = await svc.build(entry, { ...tick, volumeRatio: bad }, null);
      expect(packet.flow.volumeRatio.available).toBe(false);
      if (!packet.flow.volumeRatio.available) {
        expect(packet.flow.volumeRatio.reason).toMatch(/volume/i);
      }
    }
  });

  it('reports a real volume reading, including a zero one', async () => {
    for (const good of [0, 1.8]) {
      const packet = await svc.build(entry, { ...tick, volumeRatio: good }, null);
      expect(packet.flow.volumeRatio.available).toBe(true);
      if (packet.flow.volumeRatio.available) {
        expect(packet.flow.volumeRatio.value).toBe(good);
      }
    }
  });

  it('names the real producer of the volume ratio, with its interval', async () => {
    // It comes off `SignalGeneratorService.analyze(..., '15m').volumeRatio`, not
    // out of market-data — which is what this block used to claim. The interval
    // is part of the identity: two packets whose provenance strings match must
    // not be able to carry a 5-minute and a daily reading.
    const packet = await svc.build(
      entry,
      { ...tick, volumeRatio: 1.8, structureSource: LEVEL_SOURCE },
      null,
    );
    expect(packet.flow.volumeRatio.available).toBe(true);
    if (packet.flow.volumeRatio.available) {
      expect(packet.flow.volumeRatio.source).toBe(LEVEL_SOURCE);
      expect(packet.flow.volumeRatio.source).toMatch(/15m/);
      expect(packet.flow.volumeRatio.source).not.toBe('market-data');
    }
  });

  it('dates the level-derived blocks from the BOOK, not from the packet build', async () => {
    // `nearestSupport`, `nearestResistance` and `volumeRatio` all come off one
    // cached level book that may be up to 60s old — the same object whose derive
    // time `structure.levelBook` reports. Stamping the build time on them made
    // one packet carry two different ages for a single read.
    const derivedAt = '2026-08-14T06:00:00.000Z';
    const packet = await svc.build(
      entry,
      {
        ...tick,
        nearestSupport: 118,
        nearestResistance: 124,
        volumeRatio: 1.8,
        structureAt: derivedAt,
      },
      null,
    );

    expect(packet.structure.nearestSupport).toMatchObject({ available: true, at: derivedAt });
    expect(packet.structure.nearestResistance).toMatchObject({ available: true, at: derivedAt });
    expect(packet.flow.volumeRatio).toMatchObject({ available: true, at: derivedAt });
    // And it is genuinely NOT the build time, or this test proves nothing.
    expect(packet.session.nowUtc).not.toBe(derivedAt);
  });

  it('dates the underlying spot from when it was read, not from the packet build', async () => {
    const readAt = '2026-08-14T05:59:10.000Z';
    const packet = await svc.build(
      entry,
      { ...tick, underlyingLtp: 24010, underlyingLtpAt: readAt },
      null,
    );
    expect(packet.position.underlyingLtp).toMatchObject({ available: true, at: readAt });
    expect(packet.session.nowUtc).not.toBe(readAt);
  });

  it('falls back to the build time only when the tick has no capture time', async () => {
    const packet = await svc.build(
      entry,
      { ...tick, nearestSupport: 118, volumeRatio: 1.8, underlyingLtp: 120 },
      null,
    );
    expect(packet.structure.nearestSupport).toMatchObject({ at: packet.session.nowUtc });
    expect(packet.flow.volumeRatio).toMatchObject({ at: packet.session.nowUtc });
    expect(packet.position.underlyingLtp).toMatchObject({ at: packet.session.nowUtc });
  });

  describe('a null level never asserts a market fact the sensor did not establish', () => {
    // The defect this replaces: `nearestSupport` carried the fixed reason "no
    // support level below this price in the level book" in all FOUR cases it can
    // be null, only one of which that sentence describes. In the other three the
    // packet asserted market structure — with provenance, persisted verbatim —
    // where the truth was that we never looked. It contradicted `levelBook` in
    // the very same block.
    const STRUCTURE_UNSEEN =
      'the underlying behind this contract could not be resolved, so this instrument’s level ' +
      'book was never looked up.';

    it('uses the tick’s reason when the level book was never consulted', async () => {
      const packet = await svc.build(
        entry,
        { ...tick, nearestSupport: null, nearestResistance: null, structureReason: STRUCTURE_UNSEEN },
        null,
      );

      expect(packet.structure.nearestSupport.available).toBe(false);
      expect(packet.structure.nearestResistance.available).toBe(false);
      if (!packet.structure.nearestSupport.available) {
        expect(packet.structure.nearestSupport.reason).toBe(STRUCTURE_UNSEEN);
        // The positive claim about market structure must be GONE, not merely
        // accompanied — an LLM handed both reads the confident one.
        expect(packet.structure.nearestSupport.reason).not.toMatch(/no support level below/i);
      }
      if (!packet.structure.nearestResistance.available) {
        expect(packet.structure.nearestResistance.reason).toBe(STRUCTURE_UNSEEN);
        expect(packet.structure.nearestResistance.reason).not.toMatch(/no resistance level above/i);
      }
    });

    it('still says "no level on that side" when the book WAS built and compared', async () => {
      // structureReason null means the adapter got a book and a price and found
      // nothing below — the one case where the market-structure claim is true.
      // Losing this would replace a real finding with a shrug.
      const packet = await svc.build(entry, { ...tick, structureReason: null }, null);
      expect(packet.structure.nearestSupport.available).toBe(false);
      if (!packet.structure.nearestSupport.available) {
        expect(packet.structure.nearestSupport.reason).toMatch(/no support level below/i);
      }
    });

    it('does not contradict the levelBook block about the same failure', async () => {
      // The two blocks are two lines apart in the packet the agent reads. When
      // the underlying is unresolved they must tell the same story.
      const packet = await svc.build(
        entry,
        { ...tick, structureSymbol: null, structureReason: STRUCTURE_UNSEEN },
        null,
      );
      expect(packet.structure.levelBook.available).toBe(false);
      expect(packet.structure.nearestSupport.available).toBe(false);
      if (!packet.structure.levelBook.available && !packet.structure.nearestSupport.available) {
        expect(packet.structure.levelBook.reason).toMatch(/FAILURE TO LOOK/);
        expect(packet.structure.nearestSupport.reason).toBe(STRUCTURE_UNSEEN);
      }
    });

    it('lets a stated reason override even for a NaN level', async () => {
      const packet = await svc.build(
        entry,
        { ...tick, nearestSupport: NaN, structureReason: STRUCTURE_UNSEEN },
        null,
      );
      expect(packet.structure.nearestSupport.available).toBe(false);
      if (!packet.structure.nearestSupport.available) {
        expect(packet.structure.nearestSupport.reason).toBe(STRUCTURE_UNSEEN);
      }
    });
  });

  it('says there are no OI walls rather than showing empty ones', async () => {
    const without = await svc.build(entry, tick, null);
    expect(without.flow.oiWalls.available).toBe(false);
    if (!without.flow.oiWalls.available) expect(without.flow.oiWalls.reason).toMatch(/OI walls/i);

    const now = { callWall: 24500, putWall: 24000 };
    const prev = { callWall: 24400, putWall: 24000 };
    const withWalls = await svc.build(entry, { ...tick, oiWallNow: now, oiWallPrev: prev }, null);
    expect(withWalls.flow.oiWalls.available).toBe(true);
    if (withWalls.flow.oiWalls.available) {
      expect(withWalls.flow.oiWalls.value).toEqual({ now, previous: prev });
    }
  });

  it('surfaces the underlying price, and says when it could not be resolved', async () => {
    // An OPT position: ltp is the premium, underlyingLtp is the spot. Without
    // the latter the agent has OI walls at 24000 and an entry at 120 with
    // nothing relating them.
    const opt = { ...tick, segment: 'OPT' as const, ltp: 120, underlyingLtp: 24380 };
    const packet = await svc.build(entry, opt, null);
    expect(packet.position.ltp).toBe(120);
    expect(packet.position.underlyingLtp.available).toBe(true);
    if (packet.position.underlyingLtp.available) {
      expect(packet.position.underlyingLtp.value).toBe(24380);
    }

    const blind = await svc.build(entry, { ...opt, underlyingLtp: null }, null);
    expect(blind.position.underlyingLtp.available).toBe(false);
    if (!blind.position.underlyingLtp.available) {
      expect(blind.position.underlyingLtp.reason).toMatch(/cannot be compared|scale/i);
    }
  });

  it('carries the current price so the agent never infers it from P&L', async () => {
    const packet = await svc.build(entry, { ...tick, ltp: 113.25 }, null);
    expect(packet.position.ltp).toBe(113.25);
  });

  it('surfaces the nearest levels, each present or absent with a reason', async () => {
    const withLevels = await svc.build(
      entry,
      { ...tick, nearestSupport: 118, nearestResistance: 124 },
      null,
    );
    expect(withLevels.structure.nearestSupport.available).toBe(true);
    if (withLevels.structure.nearestSupport.available) {
      expect(withLevels.structure.nearestSupport.value).toBe(118);
    }
    expect(withLevels.structure.nearestResistance.available).toBe(true);
    if (withLevels.structure.nearestResistance.available) {
      expect(withLevels.structure.nearestResistance.value).toBe(124);
    }

    const without = await svc.build(entry, tick, null);
    expect(without.structure.nearestSupport.available).toBe(false);
    expect(without.structure.nearestResistance.available).toBe(false);

    // A NaN level must not reach the agent as a real level either.
    const broken = await svc.build(entry, { ...tick, nearestSupport: NaN }, null);
    expect(broken.structure.nearestSupport.available).toBe(false);
  });

  it('surfaces the 30-minute headline count, including a real zero', async () => {
    const quiet = await svc.build(entry, { ...tick, freshNewsCount: 0 }, null);
    expect(quiet.news.freshCount.available).toBe(true);
    if (quiet.news.freshCount.available) expect(quiet.news.freshCount.value).toBe(0);

    const unknown = await svc.build(entry, tick, null);
    expect(unknown.news.freshCount.available).toBe(false);
    if (!unknown.news.freshCount.available) {
      expect(unknown.news.freshCount.reason).toMatch(/30-minute|headline/i);
    }
  });

  it('distinguishes "no real factors computed" from a factor set', async () => {
    const empty = await svc.build(entry, tick, null);
    expect(empty.macro.realFactors.available).toBe(false);

    const withFactors = await svc.build(entry, { ...tick, factorValues: { mtfTrend: 0.4 } }, null);
    expect(withFactors.macro.realFactors.available).toBe(true);
    if (withFactors.macro.realFactors.available) {
      expect(withFactors.macro.realFactors.value).toEqual({ mtfTrend: 0.4 });
    }
  });

  it('realFactors provenance does not claim the side-agnostic volatility factor is in the UP frame', async () => {
    const p = await svc.build(entry, { ...tick, factorValues: { mtfTrend: 1, volatility: 0.5 } }, null);
    expect(p.macro.realFactors.available).toBe(true);
    if (p.macro.realFactors.available) {
      // Directional factors are normalised to "positive = supportive of UP"...
      expect(p.macro.realFactors.source).toMatch(/positive = supportive of a move UP/);
      // ...but volatility is NOT: it is the India VIX day-on-day change, unsigned by side.
      expect(p.macro.realFactors.source).toMatch(/volatility is side-agnostic/);
      expect(p.macro.realFactors.source).toMatch(/India VIX/);
      expect(p.macro.realFactors.source).not.toMatch(/sign is normalised so positive = supportive of a move UP, independent/);
    }
  });

  it('turns a failing evidence source into a stated absence, not an exception', async () => {
    levelsFor.mockRejectedValue(new Error('level book timed out'));
    const packet = await svc.build(entry, tick, null);
    expect(packet.structure.levelBook.available).toBe(false);
    if (!packet.structure.levelBook.available) {
      expect(packet.structure.levelBook.reason).toMatch(/level book timed out/);
      expect(packet.structure.levelBook.reason).toMatch(/chart-context/);
    }
    // The rest of the packet still got built.
    expect(packet.money.netPnl).toBeLessThan(2000);
  });

  it('treats an empty source result as absent rather than as evidence of nothing', async () => {
    recentFor.mockResolvedValue({ value: [], source: 'news-aggregator.service' });
    const packet = await svc.build(entry, tick, null);
    expect(packet.news.headlines.available).toBe(false);

    recentFor.mockResolvedValue(null);
    const nothingAtAll = await svc.build(entry, tick, null);
    expect(nothingAtAll.news.headlines.available).toBe(false);
  });

  it('takes provenance from the source, because the packet cannot know it', async () => {
    // Two level books from the same service differ entirely by interval; a
    // constant source string would make them indistinguishable in the corpus.
    levelsFor.mockResolvedValue({
      value: { support: [23900], resistance: [24500] },
      source: 'chart-context.service (15m)',
      at: '2026-08-14T09:45:00.000Z',
    });
    const packet = await svc.build(entry, tick, null);
    expect(packet.structure.levelBook.available).toBe(true);
    if (packet.structure.levelBook.available) {
      expect(packet.structure.levelBook.value).toEqual({ support: [23900], resistance: [24500] });
      expect(packet.structure.levelBook.source).toBe('chart-context.service (15m)');
      // The DATA's own capture time, not the packet build time.
      expect(packet.structure.levelBook.at).toBe('2026-08-14T09:45:00.000Z');
    }
  });

  it('falls back to the packet’s own build time when a source has no timestamp', async () => {
    recentFor.mockResolvedValue({
      value: [{ headline: 'Q1 beat' }],
      source: 'news-aggregator.service (last 30m)',
    });
    const packet = await svc.build(entry, tick, null);
    expect(packet.news.headlines.available).toBe(true);
    if (packet.news.headlines.available) {
      expect(packet.news.headlines.source).toBe('news-aggregator.service (last 30m)');
      expect(packet.news.headlines.at).toBe(packet.session.nowUtc);
    }
  });

  it('names the heartbeat as the trigger when no sensor fired', async () => {
    const quiet = await svc.build(entry, tick, null);
    expect(quiet.trigger.available).toBe(true);
    if (quiet.trigger.available) {
      expect(quiet.trigger.value).toEqual([
        { name: 'heartbeat', detail: 'no sensor fired; scheduled review' },
      ]);
    }

    const fires = [{ name: 'level-break', detail: 'closed below 98' }];
    const fired = await svc.build(entry, tick, null, fires);
    expect(fired.trigger.available).toBe(true);
    if (fired.trigger.available) {
      expect(fired.trigger.value).toEqual(fires);
    }
  });

  it('carries the trade’s own prior verdicts so the agent stays consistent', async () => {
    recentForTracker.mockResolvedValue([
      { verdict: 'HOLD', reason: 'structure intact', createdAt: new Date('2026-08-14T09:00:00Z') },
    ]);
    const packet = await svc.build(entry, tick, null);
    // The literal is pinned deliberately: how many prior verdicts the agent is
    // shown is a behaviour, and a limit quietly dropped to 0 would leave the
    // agent with no memory while every "has memory" assertion still passed.
    expect(recentForTracker).toHaveBeenCalledWith('t1', 3);
    expect(packet.memory.available).toBe(true);
    if (packet.memory.available) {
      expect(packet.memory.value).toHaveLength(1);
      expect(packet.memory.value).toEqual([
        { verdict: 'HOLD', reason: 'structure intact', at: '2026-08-14T09:00:00.000Z' },
      ]);
    }
  });

  it('says this is the first look rather than showing an empty history', async () => {
    recentForTracker.mockResolvedValue([]);
    const packet = await svc.build(entry, tick, null);
    expect(packet.memory.available).toBe(false);
    if (!packet.memory.available) expect(packet.memory.reason).toMatch(/first look/i);
  });

  it('copies the position’s identity through verbatim', async () => {
    const packet = await svc.build(entry, { ...tick, expiry: '2026-08-28' }, null);
    expect(packet.position).toMatchObject({
      symbol: 'INFY',
      kind: 'POSITION',
      segment: 'EQ_INTRADAY',
      side: 'LONG',
      qty: 100,
      entryPrice: 100,
      ltp: 120,
      entryTime: '2026-08-14T04:00:00.000Z',
      expiry: '2026-08-28',
    });
    expect(packet.session.expiry).toBe('2026-08-28');
  });

  it.each(['SENTINEL', 'OBSERVE_ONLY'] as const)(
    'carries ownership %s through, so the verdict is attributable to it',
    async (ownership) => {
      const packet = await svc.build({ ...entry, ownership }, tick, null);
      // A holding is "observed, never closed" and another engine's position is
      // not ours to touch — but both are still judged in Stage 0. The verdict has
      // to record which kind of trade it was about: Task 13 scores actionable and
      // never-actionable verdicts separately, and a Stage 1 executor must gate on
      // THIS field rather than on `watched`.
      expect(packet.position.ownership).toBe(ownership);
    },
  );

  it('dates the OI block from the capture, not from the packet build', async () => {
    const capturedAt = '2026-08-14T05:59:15.000Z';
    const packet = await svc.build(
      entry,
      {
        ...tick,
        oiWallNow: { callWall: 24200, putWall: 23800 },
        oiWallPrev: null,
        oiWallsAt: capturedAt,
      },
      null,
    );
    // Walls are captured on their own cadence, so this block can be up to a
    // minute older than every other one. The packet's contract is "present WITH
    // provenance" and the prompt teaches the model to read `at` — a build-time
    // stamp here would be a wrong value carrying provenance, which is the one
    // failure mode this type exists to prevent.
    expect(packet.flow.oiWalls.available).toBe(true);
    if (packet.flow.oiWalls.available) expect(packet.flow.oiWalls.at).toBe(capturedAt);
  });

  it('falls back to the build time when no capture time is supplied', async () => {
    const packet = await svc.build(
      entry,
      { ...tick, oiWallNow: { callWall: 1, putWall: 2 }, oiWallPrev: null, oiWallsAt: null },
      null,
    );
    expect(packet.flow.oiWalls.available).toBe(true);
    if (packet.flow.oiWalls.available) {
      expect(packet.flow.oiWalls.at).toBe(packet.session.nowUtc);
    }
  });

  it('stamps the session clock in IST alongside the UTC instant', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T09:45:00Z')); // Fri 15:15 IST
    try {
      const packet = await svc.build(entry, tick, null);
      expect(packet.session.nowIst).toBe('2026-08-14 15:15:00 IST');
      expect(packet.session.nowUtc).toBe('2026-08-14T09:45:00.000Z');
      expect(packet.session.minutesToClose.available).toBe(true);
      if (packet.session.minutesToClose.available) {
        expect(packet.session.minutesToClose.value).toBe(15);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  describe('exit discipline fields', () => {
    const NOISE_ABSENT = 'no noise unit measured — exit discipline is off, or the tick source read no 1-minute bars';

    it('no tick.noise ⇒ flow.noiseUnit absent with a reason, floorBasis fixed, money as before', async () => {
      const p = await svc.build(entry, tick, null);
      expect(p.flow.noiseUnit).toEqual({ available: false, reason: NOISE_ABSENT });
      expect(p.money.floorBasis).toBe('fixed');
      expect(p.money.greenFloorPrice).toBe(clampFloorTowardLtp(floorFor(tick), tick.ltp, tick.side));
    });

    it('tick.noise ⇒ present NoiseUnitValue; the underlying falls back to the level book atr14/√15', async () => {
      const contract = { n: 4.5, method: 'atr14-1m' as const, bars: 20, at: '2026-10-14T11:00:00.000Z' };
      levelsFor.mockResolvedValue({ value: { atr14: 13.5, vwap: 9000 }, source: LEVEL_SOURCE, at: '2026-10-14T10:45:00.000Z' });
      const p = await svc.build(entry, { ...tick, noise: { contract, underlying1m: null, reason: null } }, null);
      expect(p.flow.noiseUnit).toMatchObject({
        available: true,
        at: '2026-10-14T11:00:00.000Z',
        value: { contract, underlying: { n: 13.5 / Math.sqrt(15), method: 'atr14-15m-scaled', bars: 0, at: '2026-10-14T10:45:00.000Z' } },
      });
    });

    it('tick.noise with neither reading ⇒ absent with the tick reason', async () => {
      const p = await svc.build(entry, { ...tick, noise: { contract: null, underlying1m: null, reason: 'no hub 1-minute bars' } }, null);
      expect(p.flow.noiseUnit).toEqual({ available: false, reason: 'no hub 1-minute bars' });
    });

    it('tick.noiseFloor ⇒ the packet floor IS the noise floor', async () => {
      const p = await svc.build(entry, { ...tick, noiseFloor: { basis: 'noise', armed: true, level: 530.5, armPrice: 529.65, n: 4.5 } }, null);
      expect(p.money).toMatchObject({ greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' });
    });

    it('an unarmed noise floor is reported unarmed even when the fixed latch is set (the ₹150 latch never arms the noise floor)', async () => {
      const p = await svc.build(entry, { ...tick, greenFloorArmedLatched: true, noiseFloor: { basis: 'noise', armed: false, level: 529.65, armPrice: 529.65, n: 4.5 } }, null);
      expect(p.money).toMatchObject({ greenFloorPrice: 529.65, greenFloorArmed: false, floorBasis: 'noise' });
    });
  });
});

/**
 * WHICH SYMBOL REACHES EACH EVIDENCE SOURCE.
 *
 * The packet's other blocks are keyed by the broker's tradingsymbol, correctly —
 * `position.symbol` has to stay joinable to the tracker the verdict came from.
 * These two are not: the level book is looked up in the instrument master
 * (cash equities) and the headlines in `relatedSymbols` (base symbols), so a
 * derivative tradingsymbol matches NEITHER and both blocks go permanently
 * absent — in the packet the agent actually reads.
 *
 * The absence of exactly this assertion is why that survived a review round.
 */
describe('ContextPacketService — the evidence sources are keyed by the underlying', () => {
  const OPTION_TRADINGSYMBOL = 'NIFTY28AUG2524000CE';

  function make() {
    const levelsFor = jest.fn().mockResolvedValue({ value: [1], source: 'chart' });
    const recentFor = jest.fn().mockResolvedValue({ value: [1], source: 'news' });
    const recentForTracker = jest.fn().mockResolvedValue([]);
    const svc = new ContextPacketService(
      { recentForTracker } as never,
      { levelsFor } as never,
      { recentFor } as never,
    );
    jest.spyOn((svc as never as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    return { svc, levelsFor, recentFor };
  }

  const entryFor = (symbol: string) =>
    ({
      userId: 'u1',
      trackerId: 't1',
      symbol,
      kind: 'POSITION' as const,
      ownership: 'SENTINEL' as const,
      watched: true,
      reason: '',
    }) as never;

  const tickFor = (structureSymbol: string | null, over: Partial<TickSnapshot> = {}) =>
    ({
      segment: 'OPT',
      side: 'LONG',
      structureSymbol,
      entryPrice: 100,
      qty: 75,
      ltp: 120,
      underlyingLtp: 24010,
      underlyingLtpAt: null,
      underlyingLtpSource: 'market-data (underlying spot — live feed tick)',
      underlyingLtpReason: null,
      nearestSupport: null,
      nearestResistance: null,
      structureReason: null,
      structureAt: null,
      structureSource: LEVEL_SOURCE,
      holdingHigh: null,
      holdingLow: null,
      entryTime: new Date('2026-08-14T04:00:00Z'),
      expiry: '2026-08-28',
      volumeRatio: null,
      freshNewsCount: null,
      factorValues: {},
      oiWallNow: null,
      oiWallPrev: null,
      oiWallsAt: null,
      greenFloorArmedLatched: false,
      ...over,
    }) as TickSnapshot;

  it('asks BOTH sources for the UNDERLYING on a derivative, never the tradingsymbol', async () => {
    const t = make();

    await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor('NIFTY'), null, []);

    expect(t.levelsFor).toHaveBeenCalledWith('NIFTY', 'u1');
    expect(t.recentFor).toHaveBeenCalledWith('NIFTY');
    expect(t.levelsFor).not.toHaveBeenCalledWith(OPTION_TRADINGSYMBOL);
    expect(t.recentFor).not.toHaveBeenCalledWith(OPTION_TRADINGSYMBOL);
  });

  it('passes the tick source’s resolved MCX future to the level book, so a far-month option gets ITS month', async () => {
    const t = make();
    const instrument = { exchange: 'MCX', token: '488001', symbol: 'CRUDEOIL18NOV26FUT' };

    await t.svc.build(entryFor('CRUDEOIL16NOV269000CE'), tickFor('CRUDEOIL', { structureInstrument: instrument }), null, []);

    expect(t.levelsFor).toHaveBeenCalledWith('CRUDEOIL', 'u1', instrument);
    expect(t.recentFor).toHaveBeenCalledWith('CRUDEOIL');
  });

  it('still reports the position under the BROKER symbol, so the verdict stays joinable', async () => {
    const t = make();

    const packet = await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor('NIFTY'), null, []);

    // The lookup key and the identity are different questions. Rewriting
    // `position.symbol` to the underlying would make the row unjoinable against
    // the tracker it came from — and would tell the agent it is holding NIFTY
    // rather than one specific 24000 call.
    expect(packet.position.symbol).toBe(OPTION_TRADINGSYMBOL);
  });

  it('CASH is unchanged — the tradingsymbol is the key', async () => {
    const t = make();

    await t.svc.build(
      entryFor('SUZLON-EQ'),
      tickFor('SUZLON-EQ', { segment: 'EQ_INTRADAY', expiry: null, underlyingLtp: 120 }),
      null,
      [],
    );

    expect(t.levelsFor).toHaveBeenCalledWith('SUZLON-EQ', 'u1');
    expect(t.recentFor).toHaveBeenCalledWith('SUZLON-EQ');
  });

  describe('when the underlying could not be resolved', () => {
    it('calls NEITHER source rather than falling back to the tradingsymbol', async () => {
      const t = make();

      await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor(null), null, []);

      // That call is guaranteed to miss, and a miss would be recorded as a
      // finding about the market rather than as a failure to look.
      expect(t.levelsFor).not.toHaveBeenCalled();
      expect(t.recentFor).not.toHaveBeenCalled();
    });

    it('states the REAL reason on both blocks', async () => {
      const t = make();

      const packet = await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor(null), null, []);

      for (const block of [packet.structure.levelBook, packet.news.headlines]) {
        expect(block.available).toBe(false);
        const reason = (block as { reason: string }).reason;
        // The load-bearing half: it must say the absence is OURS. Reported as
        // "no level book for this symbol" it reads as a fact about the market,
        // and an LLM told that reasons confidently about an instrument with no
        // structure — a different trade entirely.
        expect(reason).toMatch(/could not be resolved/i);
        expect(reason).toMatch(/failure to look/i);
      }
    });

    it('gives each block its OWN reason rather than one shared string', async () => {
      const t = make();

      const packet = await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor(null), null, []);

      const levels = (packet.structure.levelBook as { reason: string }).reason;
      const news = (packet.news.headlines as { reason: string }).reason;
      // A news block explaining itself by talking about the level book is the
      // kind of near-miss provenance this packet's whole design is against.
      expect(levels).toMatch(/level book/i);
      expect(news).toMatch(/news/i);
      expect(news).not.toMatch(/level book/i);
    });

    it('builds the rest of the packet normally — one absent source is not an outage', async () => {
      const t = make();

      const packet = await t.svc.build(entryFor(OPTION_TRADINGSYMBOL), tickFor(null), null, []);

      expect(packet.position.symbol).toBe(OPTION_TRADINGSYMBOL);
      expect(packet.money.netPnl).toEqual(expect.any(Number));
      expect(packet.session.nowIst).toEqual(expect.any(String));
    });
  });
});

describe('ContextPacketService — news for an underlying the tagger can never match', () => {
  function make() {
    const recentFor = jest.fn().mockResolvedValue({ value: [{ title: 'x' }], source: 'news' });
    const svc = new ContextPacketService(
      { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
      { levelsFor: jest.fn().mockResolvedValue(null) } as never,
      { recentFor } as never,
    );
    jest.spyOn((svc as never as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    return { svc, recentFor };
  }
  const entry = (symbol: string, exchange: string) =>
    ({ exchange, userId: 'u1', trackerId: 't1', symbol, kind: 'POSITION', ownership: 'SENTINEL', watched: true, reason: '' }) as never;
  const tick = (structureSymbol: string, freshNewsCount: number | null) =>
    ({
      segment: 'OPT', side: 'LONG', structureSymbol, entryPrice: 100, qty: 1, ltp: 110, underlyingLtp: 280,
      underlyingLtpAt: null, underlyingLtpSource: 'x', underlyingLtpReason: null, nearestSupport: null,
      nearestResistance: null, structureReason: null, structureAt: null, structureSource: LEVEL_SOURCE,
      holdingHigh: null, holdingLow: null, entryTime: new Date('2026-10-12T10:00:00Z'), expiry: null,
      volumeRatio: null, freshNewsCount, factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null,
      oiWallsAt: null, greenFloorArmedLatched: false,
    }) as TickSnapshot;

  it('MCX ZINC: headlines AND freshCount are unavailable with the tagger reason — never a present 0', async () => {
    const t = make();
    const packet = await t.svc.build(entry('ZINC30OCT26280CE', 'MCX'), tick('ZINC', 0), null, []);
    expect(t.recentFor).not.toHaveBeenCalled();
    for (const block of [packet.news.headlines, packet.news.freshCount]) {
      expect(block.available).toBe(false);
      expect((block as { reason: string }).reason).toMatch(/never tagged.*ZINC|ZINC.*never tagged/);
    }
  });

  it('NFO FINNIFTY: the same — no headline mapping for that index', async () => {
    const t = make();
    const packet = await t.svc.build(entry('FINNIFTY28OCT2626000CE', 'NFO'), tick('FINNIFTY', 0), null, []);
    expect(packet.news.freshCount.available).toBe(false);
    expect(packet.news.headlines.available).toBe(false);
  });

  it('MCX CRUDEOIL and NFO NIFTY are mapped: a real zero is still a present 0', async () => {
    const t = make();
    const crude = await t.svc.build(entry('CRUDEOIL16NOV269000CE', 'MCX'), tick('CRUDEOIL', 0), null, []);
    expect(crude.news.freshCount).toEqual(expect.objectContaining({ available: true, value: 0 }));
    expect(crude.news.headlines.available).toBe(true);
    const nifty = await t.svc.build(entry('NIFTY28OCT2625000CE', 'NFO'), tick('NIFTY', 0), null, []);
    expect(nifty.news.freshCount).toEqual(expect.objectContaining({ available: true, value: 0 }));
  });
});

describe('ContextPacketService — commodity benchmarks in macro.globalCues for MCX positions', () => {
  const q = (symbol: string, last: number, at: string, over: Record<string, unknown> = {}) => ({
    values: { symbol, last, previousClose: last - 1, change: 1, changePercent: 1.1, contract: `${symbol} (Nov'26)` },
    sourceTime: at,
    fetchedAt: '2026-10-12T17:50:00.000Z',
    basis: 'quote time',
    source: `CNBC quote JSON ${symbol}`,
    status: 'ok',
    ...over,
  });
  const none = { values: null, sourceTime: null, fetchedAt: null, basis: '', source: '', status: 'unavailable', reason: 'not fetched yet in this process' };
  const snapshot = {
    enabled: true,
    us: { nasdaq: none, sp500: none, dow: none, nasdaqFutures: none, sp500Futures: none },
    commodities: {
      wtiCrude: q('CL=F', 93.85, '2026-10-12T17:44:17.000Z'),
      brentCrude: q('BZ=F', 106.8, '2026-10-12T17:44:18.000Z'),
      gold: q('GC=F', 4193, '2026-10-12T17:44:19.000Z', { status: 'stale', reason: 'COMEX gold futures quote is 45 minutes old (limit 30)' }),
      silver: q('SI=F', 60.51, '2026-10-12T17:43:13.000Z'),
      naturalGas: none,
      copper: q('HG=F', 6.75, '2026-10-12T17:43:43.000Z'),
      usdInr: q('USDINR', 95.77, '2026-10-12T10:02:00.000Z'),
    },
    fiiDii: none,
    fiiOi: none,
    gift: none,
    preOpen: none,
  };
  function make(snap: unknown = snapshot) {
    const svc = new ContextPacketService(
      { recentForTracker: jest.fn().mockResolvedValue([]) } as never,
      { levelsFor: jest.fn().mockResolvedValue(null) } as never,
      { recentFor: jest.fn().mockResolvedValue(null) } as never,
      { peek: () => snap } as never,
    );
    jest.spyOn((svc as never as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    return svc;
  }
  const entry = (symbol: string, exchange: string) =>
    ({ exchange, userId: 'u1', trackerId: 't1', symbol, kind: 'POSITION', ownership: 'SENTINEL', watched: true, reason: '' }) as never;
  const tick = (structureSymbol: string) =>
    ({
      segment: 'OPT', side: 'LONG', structureSymbol, entryPrice: 100, qty: 1, ltp: 110, underlyingLtp: 8900,
      underlyingLtpAt: null, underlyingLtpSource: 'x', underlyingLtpReason: null, nearestSupport: null,
      nearestResistance: null, structureReason: null, structureAt: null, structureSource: LEVEL_SOURCE,
      holdingHigh: null, holdingLow: null, entryTime: new Date('2026-10-12T10:00:00Z'), expiry: null,
      volumeRatio: null, freshNewsCount: null, factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null,
      oiWallsAt: null, greenFloorArmedLatched: false,
    }) as TickSnapshot;
  const cues = (p: { macro: { globalCues: { available: boolean } } }) =>
    (p.macro.globalCues as { available: true; value: Record<string, any> }).value;

  it('crude: WTI and Brent plus USD/INR, each with its own time and status; no gold', async () => {
    const p = await make().build(entry('CRUDEOIL16NOV269000CE', 'MCX'), tick('CRUDEOIL'), null, []);
    expect(p.macro.globalCues.available).toBe(true);
    const g = cues(p);
    expect(g.wtiCrude).toEqual({
      available: true,
      at: '2026-10-12T17:44:17.000Z',
      source: 'CNBC quote JSON CL=F; quote time',
      value: expect.objectContaining({ last: 93.85, contract: "CL=F (Nov'26)", status: 'ok' }),
    });
    expect(g.brentCrude.value.last).toBe(106.8);
    expect(g.usdInr.value.last).toBe(95.77);
    expect(g.gold).toBeUndefined();
    // The US blocks are still there, absent with their own reasons.
    expect(g.nasdaq).toEqual({ available: false, reason: expect.stringMatching(/not fetched/) });
  });

  it('a mini reads its benchmark: GOLDM → gold (stale, with the note) + USD/INR', async () => {
    const g = cues(await make().build(entry('GOLDM05NOV26120000CE', 'MCX'), tick('GOLDM'), null, []));
    expect(g.gold.value).toEqual(expect.objectContaining({ last: 4193, status: 'stale', note: expect.stringMatching(/45 minutes/) }));
    expect(g.usdInr.available).toBe(true);
    expect(g.wtiCrude).toBeUndefined();
  });

  it('a benchmark the cache does not hold is a nested absence with its reason', async () => {
    const g = cues(await make().build(entry('NATURALGAS27OCT26300CE', 'MCX'), tick('NATURALGAS'), null, []));
    expect(g.naturalGas).toEqual({ available: false, reason: expect.stringMatching(/not fetched/) });
  });

  it('an MCX underlying with no benchmark fetched says so (mcxBenchmark), and still gets USD/INR', async () => {
    const g = cues(await make().build(entry('ZINC30OCT26280CE', 'MCX'), tick('ZINC'), null, []));
    expect(g.mcxBenchmark).toEqual({ available: false, reason: expect.stringMatching(/ZINC/) });
    expect(g.usdInr.available).toBe(true);
  });

  it('an NSE / NFO position gets no commodity blocks', async () => {
    const g = (await make().build(entry('NIFTY28OCT2625000CE', 'NFO'), tick('NIFTY'), null, [])).macro.globalCues;
    // Nothing held for the US/GIFT keys in this snapshot → the whole block is absent, with a reason.
    expect(g.available).toBe(false);
  });

  it('cues switched off: the reason is the switch, not a stub naming cues that never existed', async () => {
    const p = await make({ enabled: false }).build(entry('CRUDEOIL16NOV269000CE', 'MCX'), tick('CRUDEOIL'), null, []);
    expect(p.macro.globalCues.available).toBe(false);
    const reason = (p.macro.globalCues as { reason: string }).reason;
    expect(reason).toMatch(/MARKET_CUES_ENABLED/);
    expect(reason).not.toMatch(/stub|\(gold, crude-oil, nasdaq\)/);
  });
});
