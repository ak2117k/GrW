import { BANKNIFTY_23NOV_1M, ist } from '../market-hub/testing/banknifty-2026-11-23-preopen';
import { capturedSql, rowsPassing, sessionBounds } from '../market-hub/testing/captured-sql';
import { EntryEngineRepository } from './entry-engine.repository';

/** 2026-11-24: the entry engine's trend bars (candles_1m) are session minutes only, filtered in SQL. */
describe('EntryEngineRepository.hubBars: session minutes only', () => {
  const make = () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    return { prisma, repo: new EntryEngineRepository(prisma as never) };
  };

  it('NSE line: BANKNIFTY 23-Nov loses the pre-open rows; MCX keeps its 09:00 open', async () => {
    const { prisma, repo } = make();
    await repo.hubBars('NSE', '99926009', new Date(ist('2026-11-23 00:00')), new Date(ist('2026-11-23 09:30')));
    await repo.hubBars('MCX', '472790', new Date(ist('2026-11-23 00:00')), new Date(ist('2026-11-23 09:30')));
    const nse = capturedSql(prisma.$queryRaw.mock.calls, 0);
    expect(sessionBounds(nse)).toEqual({ from: '09:15', to: '15:30' });
    expect(rowsPassing(nse, BANKNIFTY_23NOV_1M)[0].ts).toBe(ist('2026-11-23 09:15'));
    expect(sessionBounds(capturedSql(prisma.$queryRaw.mock.calls, 1))).toEqual({ from: '09:00', to: '23:55' });
  });
});
