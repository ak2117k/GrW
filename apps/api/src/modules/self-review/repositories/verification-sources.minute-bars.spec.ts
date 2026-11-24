import { BANKNIFTY_23NOV_1M, ist } from '../../market-hub/testing/banknifty-2026-11-23-preopen';
import { VerificationSourcesRepository } from './verification-sources.repository';

describe('VerificationSourcesRepository.minuteBarsHL: session minutes only (2026-11-24)', () => {
  const rows = [{ ts: new Date(ist('2026-11-23 02:00')), open: 64635.2, high: 64635.2, low: 64635.2, close: 64635.2 }, ...BANKNIFTY_23NOV_1M.map((b) => ({ ...b, ts: new Date(b.ts) }))];

  it("drops the 02:00 copy and the 09:00–09:14 pre-open: the exit's N comes from session bars", async () => {
    const prisma = { hubCandle1m: { findMany: jest.fn().mockResolvedValue(rows) } };
    const repo = new VerificationSourcesRepository(prisma as never);
    const bars = await repo.minuteBarsHL('NSE', '99926009', new Date(ist('2026-11-23 00:00')), new Date(ist('2026-11-23 09:30')));
    expect(bars).toHaveLength(15);
    expect(bars[0]).toMatchObject({ ts: ist('2026-11-23 09:15'), open: 65003.7 });
  });

  it('MCX keeps 09:00 onwards', async () => {
    const t = (hhmm: string) => ({ ts: new Date(ist(`2026-11-23 ${hhmm}`)), open: 1, high: 2, low: 1, close: 1 });
    const prisma = { hubCandle1m: { findMany: jest.fn().mockResolvedValue([t('08:59'), t('09:00'), t('23:54'), t('23:55')]) } };
    const bars = await new VerificationSourcesRepository(prisma as never).minuteBarsHL('MCX', 'x', new Date(0), new Date());
    expect(bars.map((b) => b.ts)).toEqual([ist('2026-11-23 09:00'), ist('2026-11-23 23:54')]);
  });
});
