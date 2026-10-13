import { UniverseScannerWorker } from './universe-scanner.worker';

/**
 * The scanner resolved its universe ONCE at boot. The core index rows are now
 * ensured by the (detached) instrument-master boot pass, which can land after
 * the scanner's own boot resolve — so a symbol missing at boot must be retried
 * on the next scan instead of being skipped for the life of the process.
 */
describe('UniverseScannerWorker instrument resolution', () => {
  it('re-resolves a symbol that was missing at boot once its row exists', async () => {
    const rows: any[] = [];
    const prisma = {
      instrument: {
        findFirst: jest.fn(async ({ where }: any) =>
          rows.find(
            (r) =>
              r.symbol === where.symbol &&
              r.exchange === where.exchange &&
              (!where.segment || where.segment.in.includes(r.segment)),
          ) ?? null,
        ),
      },
    };
    const marketDataRepo = { getCandles: jest.fn().mockResolvedValue([]) };
    const worker = new UniverseScannerWorker(
      prisma as any,
      marketDataRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await (worker as any).resolveUniverseInstruments();
    rows.push({ id: 'nifty-id', symbol: 'NIFTY', exchange: 'NSE', token: '99926000', segment: 'INDEX' });

    const results = await worker.runOnce();
    const nifty = results.find((r) => r.symbol === 'NIFTY')!;

    expect(nifty.reason).not.toBe('instrument not resolved');
    expect(marketDataRepo.getCandles).toHaveBeenCalledWith('nifty-id', expect.any(String), expect.any(Date), expect.any(Date), expect.any(Number));
  });
});
