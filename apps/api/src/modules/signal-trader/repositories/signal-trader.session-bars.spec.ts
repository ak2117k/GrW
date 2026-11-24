import { BANKNIFTY_23NOV_1M, ist } from '../../market-hub/testing/banknifty-2026-11-23-preopen';
import { capturedSql, rowsPassing, sessionBounds } from '../../market-hub/testing/captured-sql';
import { SignalTraderRepository } from './signal-trader.repository';

/** 2026-11-24: every candles_1m read of the signal trader is session minutes only, filtered in SQL. */
describe('SignalTraderRepository candles_1m reads: session minutes only', () => {
  const from = new Date(ist('2026-11-23 00:00'));
  const to = new Date(ist('2026-11-23 09:30'));
  const make = () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    return { prisma, repo: new SignalTraderRepository(prisma as never) };
  };

  it('hubMinuteBars (judge N1/N5, extremeSince): BANKNIFTY 23-Nov loses the 08:50–09:14 pre-open rows', async () => {
    const { prisma, repo } = make();
    await repo.hubMinuteBars('NSE', '99926009', from, to);
    const q = capturedSql(prisma.$queryRaw.mock.calls);
    expect(sessionBounds(q)).toEqual({ from: '09:15', to: '15:30' });
    const kept = rowsPassing(q, BANKNIFTY_23NOV_1M);
    expect(kept[0].ts).toBe(ist('2026-11-23 09:15'));
    expect(kept.every((b) => b.ts >= ist('2026-11-23 09:15'))).toBe(true);
  });

  it('hub15mBars (trend tag, entry gates) and minuteCloses (OI check, MCX future at capture)', async () => {
    const { prisma, repo } = make();
    await repo.hub15mBars('NSE', '99926000', from, to);
    await repo.minuteCloses('MCX', '472790', from, to);
    expect(sessionBounds(capturedSql(prisma.$queryRaw.mock.calls, 0))).toEqual({ from: '09:15', to: '15:30' });
    expect(sessionBounds(capturedSql(prisma.$queryRaw.mock.calls, 1))).toEqual({ from: '09:00', to: '23:55' });
  });
});
