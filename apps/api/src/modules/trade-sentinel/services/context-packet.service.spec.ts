import { computeGreenFloor } from '../charges';
import {
  ContextPacketService,
  absent,
  clampFloorTowardLtp,
  present,
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
  it('pulls a long floor that sits above the market back down to it', () => {
    expect(clampFloorTowardLtp(101.6, 101, 'LONG')).toBe(101);
  });

  it('pushes a short floor that sits below the market back up to it', () => {
    expect(clampFloorTowardLtp(98.4, 99, 'SHORT')).toBe(99);
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

describe('ContextPacketService', () => {
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const levelsFor = jest.fn().mockResolvedValue(null);
  const recentFor = jest.fn().mockResolvedValue([]);

  const svc = new ContextPacketService(
    { recentForTracker } as any,
    { levelsFor } as any,
    { recentFor } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    recentForTracker.mockResolvedValue([]);
    levelsFor.mockResolvedValue(null);
    recentFor.mockResolvedValue([]);
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  });

  const entry = {
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
  };

  it('marks every stubbed macro factor unavailable with a stated reason', async () => {
    const packet = await svc.build(entry, tick, null);
    for (const block of [packet.macro.fiiDii, packet.macro.sector, packet.macro.globalCues]) {
      expect(block.available).toBe(false);
      if (!block.available) expect(block.reason).toMatch(/stub/i);
    }
    // FII/DII is post-close data; the agent must never treat it as intraday.
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

  it('never reports a long’s floor above the market it would be stopped in', async () => {
    // At the arming tick the solved floor lands one conservative tick ABOVE ltp.
    const armingTick = { ...tick, ltp: 101 };
    const raw = computeGreenFloor({
      segment: armingTick.segment,
      entryPrice: armingTick.entryPrice,
      ltp: armingTick.ltp,
      qty: armingTick.qty,
      side: armingTick.side,
    }).floorPrice;
    expect(raw).not.toBeNull();
    expect(raw as number).toBeGreaterThan(armingTick.ltp); // the defect is really present

    const packet = await svc.build(entry, armingTick, null);
    expect(packet.money.greenFloorPrice).toBe(armingTick.ltp);
  });

  it('never reports a short’s floor below the market it would be stopped in', async () => {
    const armingTick = { ...tick, side: 'SHORT' as const, ltp: 99 };
    const raw = computeGreenFloor({
      segment: armingTick.segment,
      entryPrice: armingTick.entryPrice,
      ltp: armingTick.ltp,
      qty: armingTick.qty,
      side: armingTick.side,
    }).floorPrice;
    expect(raw as number).toBeLessThan(armingTick.ltp);

    const packet = await svc.build(entry, armingTick, null);
    expect(packet.money.greenFloorPrice).toBe(armingTick.ltp);
  });

  it('states plainly when no thesis has been formed yet', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.thesis.available).toBe(false);
    if (!packet.thesis.available) expect(packet.thesis.reason).toMatch(/no thesis/i);
  });

  it('attributes a thesis to the user when the user set it', async () => {
    const thesis = {
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
      expect(packet.thesis.value).toBe(thesis);
      expect(packet.thesis.source).toMatch(/user/i);
    }

    const inferred = await svc.build(entry, tick, { ...thesis, source: 'AGENT' });
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
    expect(packet.structure.available).toBe(false);
    if (!packet.structure.available) {
      expect(packet.structure.reason).toMatch(/level book timed out/);
      expect(packet.structure.reason).toMatch(/chart-context/);
    }
    // The rest of the packet still got built.
    expect(packet.money.netPnl).toBeLessThan(2000);
  });

  it('treats an empty source result as absent rather than as evidence of nothing', async () => {
    recentFor.mockResolvedValue([]);
    const packet = await svc.build(entry, tick, null);
    expect(packet.news.available).toBe(false);

    recentFor.mockResolvedValue([{ headline: 'Q1 beat' }]);
    const withNews = await svc.build(entry, tick, null);
    expect(withNews.news.available).toBe(true);
    if (withNews.news.available) {
      expect(withNews.news.value).toEqual([{ headline: 'Q1 beat' }]);
      expect(withNews.news.source).toBe('news-aggregator.service');
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
    expect(packet.position).toEqual({
      symbol: 'INFY',
      kind: 'POSITION',
      segment: 'EQ_INTRADAY',
      side: 'LONG',
      qty: 100,
      entryPrice: 100,
      entryTime: '2026-08-14T04:00:00.000Z',
      expiry: '2026-08-28',
    });
    expect(packet.session.expiry).toBe('2026-08-28');
  });
});
