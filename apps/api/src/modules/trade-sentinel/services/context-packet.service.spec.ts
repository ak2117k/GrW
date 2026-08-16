import { computeGreenFloor } from '../charges';
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

  it('marks every stubbed macro factor unavailable with a stated reason', async () => {
    const packet = await svc.build(entry, tick, null);
    for (const block of [packet.macro.fiiDii, packet.macro.sector, packet.macro.globalCues]) {
      expect(block.available).toBe(false);
      if (!block.available) expect(block.reason).toMatch(/stub/i);
    }
    // FII/DII is post-close data; the agent must never treat it as intraday.
    expect(packet.macro.fiiDii.available).toBe(false);
    if (!packet.macro.fiiDii.available) {
      expect(packet.macro.fiiDii.reason).toMatch(/post-close/i);
    }
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
