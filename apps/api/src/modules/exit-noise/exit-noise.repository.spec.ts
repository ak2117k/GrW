import { BANKNIFTY_23NOV_1M, ist } from '../market-hub/testing/banknifty-2026-11-23-preopen';
import { capturedSql, rowsPassing, sessionBounds } from '../market-hub/testing/captured-sql';
import { ExitNoiseRepository } from './exit-noise.repository';

describe('ExitNoiseRepository.minuteBars: session minutes only (2026-11-24)', () => {
  it('an exit at 09:25 reads 09:15 onwards, not the pre-open auction; MCX keeps its own session', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const repo = new ExitNoiseRepository(prisma as never);
    await repo.minuteBars('NSE', '99926009', new Date(ist('2026-11-23 08:50')), new Date(ist('2026-11-23 09:25')));
    await repo.minuteBars('MCX', '472790', new Date(ist('2026-11-23 08:50')), new Date(ist('2026-11-23 09:25')));
    const q = capturedSql(prisma.$queryRaw.mock.calls, 0);
    expect(sessionBounds(q)).toEqual({ from: '09:15', to: '15:30' });
    const kept = rowsPassing(q, BANKNIFTY_23NOV_1M.filter((b) => b.ts <= ist('2026-11-23 09:25')));
    expect(kept.map((b) => b.ts)[0]).toBe(ist('2026-11-23 09:15'));
    expect(Math.max(...kept.map((b) => b.high))).toBe(65182.45);
    expect(sessionBounds(capturedSql(prisma.$queryRaw.mock.calls, 1))).toEqual({ from: '09:00', to: '23:55' });
  });
});
