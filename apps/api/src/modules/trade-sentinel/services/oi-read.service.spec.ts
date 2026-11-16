import { Logger } from '@nestjs/common';
import { OiReadService, istDayStart } from './oi-read.service';

const live = [
  { strikePrice: 12, ceData: { oi: 400, ltp: 1.7 }, peData: { oi: 3165, ltp: 0.25 } },
  { strikePrice: 14, ceData: { oi: 6188, ltp: 0.3 }, peData: { oi: 300, ltp: 1.1 } },
];
const prevLive = [
  { strikePrice: 12, ceData: { oi: 400, ltp: 1.6 }, peData: { oi: 2765, ltp: 0.3 } },
  { strikePrice: 14, ceData: { oi: 6100, ltp: 0.4 }, peData: { oi: 300, ltp: 1.2 } },
];
const stale = [{ strikePrice: 12, ceData: { oi: 400, ltp: 0 }, peData: { oi: 2765, ltp: 0 } }];
const expiry = new Date('2026-11-18T00:00:00.000Z');
const meta = (id: string, at: string, source = 'NSE') => ({ id, capturedAt: new Date(at), source, expiryDate: expiry, spotPrice: 13.4 });

describe('OiReadService', () => {
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const prisma = { optionChainSnapshot: { findMany, findUnique } } as any;
  let warn: jest.SpyInstance;
  const chains: Record<string, unknown> = { pre: stale, now: live, prev: prevLive, prevStale: stale };

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    findUnique.mockImplementation(async ({ where }: any) => ({ chainJson: chains[where.id] }));
  });
  afterEach(() => warn.mockRestore());

  it('skips stale pre-open rows, and baselines on the previous session, same source', async () => {
    findMany
      .mockResolvedValueOnce([meta('pre', '2026-11-16T03:40:00Z'), meta('now', '2026-11-16T03:30:00Z')])
      .mockResolvedValueOnce([meta('prevStale', '2026-11-13T10:05:00Z'), meta('prev', '2026-11-13T09:59:00Z')]);
    const r = await new OiReadService(prisma).read('nifty', 13.4);
    expect(r).not.toBeNull();
    expect(r!.asOf).toBe('2026-11-16T03:30:00.000Z');
    expect(r!.baselineAsOf).toBe('2026-11-13T09:59:00.000Z');
    expect(r!.support[0]).toMatchObject({ strike: 12, oiChg: 400 });
    const baseQuery = findMany.mock.calls[1][0];
    expect(baseQuery.where).toMatchObject({ underlying: 'NIFTY', source: 'NSE', expiryDate: expiry });
    // Previous session = strictly before IST midnight of the latest's day.
    expect(baseQuery.where.capturedAt.lt).toEqual(new Date('2026-11-15T18:30:00.000Z'));
  });

  it('caches snapshots for 60 s per underlying but recomputes with the new spot', async () => {
    findMany.mockResolvedValueOnce([meta('now', '2026-11-16T03:30:00Z')]).mockResolvedValueOnce([]);
    const svc = new OiReadService(prisma);
    const a = await svc.read('NIFTY', 13.4);
    const b = await svc.read('NIFTY', 12.9);
    expect(findMany).toHaveBeenCalledTimes(2); // one latest + one baseline query, once
    expect(a!.spot).toBe(13.4);
    expect(b!.spot).toBe(12.9);
    expect(a!.changeBasis).toBe('none');
  });

  it('returns null when every recent row is stale, and says so once', async () => {
    findMany.mockResolvedValue([meta('pre', '2026-11-16T03:40:00Z')]);
    const svc = new OiReadService(prisma);
    expect(await svc.read('STALEONE', 13.4)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await expect(new OiReadService(prisma).read('BOOM', 100)).resolves.toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/BOOM.*db down/);
  });

  it('istDayStart is IST midnight', () => {
    expect(istDayStart(new Date('2026-11-16T20:00:00Z'))).toEqual(new Date('2026-11-16T18:30:00.000Z'));
    expect(istDayStart(new Date('2026-11-16T03:00:00Z'))).toEqual(new Date('2026-11-15T18:30:00.000Z'));
  });
});
