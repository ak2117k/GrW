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
    entryPrice: 100,
    qty: 100,
    ltp: 120,
    underlyingLtp: 120,
    nearestSupport: null,
    nearestResistance: null,
    holdingHigh: 125,
    holdingLow: 98,
    entryTime: new Date('2026-08-14T04:00:00Z'),
    expiry: null,
    volumeRatio: null,
    freshNewsCount: null,
    factorValues: {},
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
        expect(packet.flow.volumeRatio.source).toBe('market-data');
      }
    }
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
