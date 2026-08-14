import { OiWallSnapshotService } from './oi-wall-snapshot.service';

describe('OiWallSnapshotService', () => {
  const findFirst = jest.fn();
  const create = jest.fn();
  const prisma = { oiWallSnapshot: { findFirst, create } } as any;
  const oiWall = { walls: jest.fn() } as any;
  const svc = new OiWallSnapshotService(prisma, oiWall);

  beforeEach(() => jest.clearAllMocks());

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
});
