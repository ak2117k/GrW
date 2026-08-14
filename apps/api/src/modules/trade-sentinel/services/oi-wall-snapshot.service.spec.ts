import { Logger } from '@nestjs/common';
import { OiWallSnapshotService } from './oi-wall-snapshot.service';

describe('OiWallSnapshotService', () => {
  const findFirst = jest.fn();
  const create = jest.fn();
  const prisma = { oiWallSnapshot: { findFirst, create } } as any;
  const oiWall = { walls: jest.fn() } as any;
  const svc = new OiWallSnapshotService(prisma, oiWall);
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('returns both nulls when the symbol has no chain, and stores nothing', async () => {
    oiWall.walls.mockResolvedValue([]);
    const result = await svc.captureAndCompare('INFY', '2026-08-28', 1500);
    expect(result).toEqual({ now: null, prev: null });
    expect(create).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('passes the underlying price through so the walls come back sided OTM', async () => {
    // OiWallService.walls(symbol, ltp) uses ltp to keep only OTM strikes; a
    // dropped/zeroed ltp silently disables that filter and yields ITM "walls".
    oiWall.walls.mockResolvedValue([]);
    await svc.captureAndCompare('NIFTY', '2026-08-28', 24100);
    expect(oiWall.walls).toHaveBeenCalledWith('NIFTY', 24100);
  });

  it('reads the previous snapshot BEFORE writing the new one', async () => {
    const order: string[] = [];
    oiWall.walls.mockResolvedValue([
      { price: 24200, kind: 'OI_CALL', score: 30 },
      { price: 24400, kind: 'OI_CALL', score: 20 },
      { price: 24000, kind: 'OI_PUT', score: 30 },
      { price: 23800, kind: 'OI_PUT', score: 20 },
    ]);
    findFirst.mockImplementation(async () => {
      order.push('read');
      return { callWall: 24300, putWall: 23900 };
    });
    create.mockImplementation(async () => {
      order.push('write');
      return {};
    });

    const result = await svc.captureAndCompare('NIFTY', '2026-08-28', 24100);

    expect(order).toEqual(['read', 'write']);
    expect(result.prev).toEqual({ callWall: 24300, putWall: 23900 });
    // Top-scoring call strike is the call wall, top-scoring put strike the put wall.
    expect(result.now).toEqual({ callWall: 24200, putWall: 24000 });
    expect(create).toHaveBeenCalledWith({
      data: { symbol: 'NIFTY', expiry: '2026-08-28', callWall: 24200, putWall: 24000 },
    });
  });

  it('records a wall as null when the chain yields only one side', async () => {
    oiWall.walls.mockResolvedValue([{ price: 24000, kind: 'OI_PUT', score: 30 }]);
    findFirst.mockResolvedValue(null);
    const result = await svc.captureAndCompare('NIFTY', '2026-08-28', 24100);
    expect(result.now).toEqual({ callWall: null, putWall: 24000 });
  });

  it('reports prev as null on the first ever snapshot, and still stores it', async () => {
    oiWall.walls.mockResolvedValue([{ price: 100, kind: 'OI_CALL', score: 30 }]);
    findFirst.mockResolvedValue(null);
    const result = await svc.captureAndCompare('NIFTY', '2026-08-28', 90);
    expect(result.prev).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('compares against the latest snapshot for this symbol and expiry', async () => {
    oiWall.walls.mockResolvedValue([{ price: 100, kind: 'OI_CALL', score: 30 }]);
    findFirst.mockResolvedValue(null);
    await svc.captureAndCompare('NIFTY', '2026-08-28', 90);
    expect(findFirst).toHaveBeenCalledWith({
      where: { symbol: 'NIFTY', expiry: '2026-08-28' },
      orderBy: { capturedAt: 'desc' },
    });
  });

  describe('when the underlying spot is unusable', () => {
    // Without a spot, walls() cannot side its strikes OTM and returns ITM
    // high-OI strikes as "walls". Storing that would poison the NEXT
    // comparison, which diffs a correctly-sided reading against it and reports
    // a large shift that never happened. A persisted false positive outlives
    // the bad call that created it, so store nothing at all.
    it.each([
      ['null', null],
      ['zero', 0],
      ['negative', -1],
    ])('stores nothing and reads nothing when the spot is %s', async (label, ltp) => {
      oiWall.walls.mockResolvedValue([{ price: 24200, kind: 'OI_CALL', score: 30 }]);
      const result = await svc.captureAndCompare(`SPOT_${label}`, '2026-08-28', ltp as number | null);
      expect(result).toEqual({ now: null, prev: null });
      expect(create).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
      // Not even asked for — an unsided reading is worse than no reading.
      expect(oiWall.walls).not.toHaveBeenCalled();
    });

    it('says why, instead of skipping silently', async () => {
      await svc.captureAndCompare('MISSINGSPOT', '2026-08-28', null);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/MISSINGSPOT.*spot/i);
    });
  });

  describe('when walls() comes back empty', () => {
    // walls() returns [] for a cash stock (a fact), a FAILED chain fetch, and
    // an unwired options-chain service — all indistinguishable from here. A
    // permanently failing chain must not leave this sensor silent with no trace.
    it('warns, naming the cause as ambiguous', async () => {
      oiWall.walls.mockResolvedValue([]);
      await svc.captureAndCompare('EMPTYCHAIN', '2026-08-28', 1500);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/EMPTYCHAIN/);
      expect(warn.mock.calls[0][0]).toMatch(/indistinguishable/i);
    });

    it('warns ONCE per symbol, not once per poll', async () => {
      oiWall.walls.mockResolvedValue([]);
      await svc.captureAndCompare('NOISYPOLL', '2026-08-28', 1500);
      await svc.captureAndCompare('NOISYPOLL', '2026-08-28', 1500);
      await svc.captureAndCompare('NOISYPOLL', '2026-08-28', 1500);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('still warns separately for a different symbol', async () => {
      oiWall.walls.mockResolvedValue([]);
      await svc.captureAndCompare('QUIETONE', '2026-08-28', 1500);
      await svc.captureAndCompare('QUIETTWO', '2026-08-28', 1500);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
