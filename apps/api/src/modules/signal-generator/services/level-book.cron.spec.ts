import { LevelBookCron } from './level-book.cron';
import { MarketDataModule } from '../../market-data/market-data.module';
import { DailyBackfillWorker } from '../../market-data/workers/daily-backfill.worker';
import { LEVEL_BOOK_BACKFILL_WAIT_MS } from './level-book.cron';

/**
 * Guards the port bind, not the seeding.
 *
 * This hook awaited `backfillUniverseAtBoot()` — a rate-limited walk of the
 * NSE+MCX universe across four timeframes, which `DailyBackfillWorker` already
 * runs fire-and-forget at boot with the comment "we don't want to block API
 * readiness behind it". Awaiting it here undid that decision and did the work a
 * second time, in front of `app.listen()`, which is what made the first login
 * of the day take minutes.
 *
 * The boot sequence itself is unchanged and still ordered — backfill, then
 * seed, then lock the opening range. It simply no longer gates the port.
 */
describe('LevelBookCron boot hook', () => {
  const build = (overrides: Record<string, unknown> = {}) => {
    const seedSession = jest.fn().mockResolvedValue(undefined);
    const lockOpeningRange = jest.fn().mockResolvedValue(undefined);
    const waitForBootBackfill =
      (overrides.waitForBootBackfill as jest.Mock) ??
      jest.fn().mockResolvedValue(undefined);

    const cron = new LevelBookCron(
      { seedUniverse: jest.fn() } as any,
      {} as any,
      { waitForBootBackfill } as any,
    );
    // The seeding steps are exercised by their own tests; here they only need
    // to be observable, so the hook's ordering can be asserted.
    (cron as any).seedSession = seedSession;
    (cron as any).lockOpeningRange = lockOpeningRange;
    return { cron, seedSession, lockOpeningRange, waitForBootBackfill };
  };

  it('returns without waiting for the boot backfill, so the port can bind', async () => {
    const waitForBootBackfill = jest.fn().mockReturnValue(new Promise(() => {}));
    const { cron } = build({ waitForBootBackfill });

    const outcome = await Promise.race([
      Promise.resolve(cron.onModuleInit()).then(() => 'hook settled'),
      new Promise((resolve) => {
        setTimeout(() => resolve('hook blocked on the backfill'), 100).unref();
      }),
    ]);

    expect(outcome).toBe('hook settled');
    expect(waitForBootBackfill).toHaveBeenCalledTimes(1);
  });

  it('still seeds in order once the backfill finishes', async () => {
    const { cron, seedSession, lockOpeningRange, waitForBootBackfill } = build();

    cron.onModuleInit();
    // Let the detached sequence run to completion.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(waitForBootBackfill).toHaveBeenCalledTimes(1);
    expect(seedSession).toHaveBeenCalledTimes(1);
    expect(lockOpeningRange).toHaveBeenCalledTimes(1);
    expect(seedSession.mock.invocationCallOrder[0]).toBeGreaterThan(
      waitForBootBackfill.mock.invocationCallOrder[0],
    );
    expect(lockOpeningRange.mock.invocationCallOrder[0]).toBeGreaterThan(
      seedSession.mock.invocationCallOrder[0],
    );
  });

  it('still seeds when the backfill fails', async () => {
    const waitForBootBackfill = jest.fn().mockRejectedValue(new Error('broker down'));
    const { cron, seedSession } = build({ waitForBootBackfill });

    cron.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seedSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wait above was dead code in production: MarketDataModule did not export
 * DailyBackfillWorker, so LevelBookCron's @Optional() dependency was always
 * undefined and the books seeded BEFORE the boot backfill landed.
 */
describe('LevelBookCron waits on the ONE shared boot backfill', () => {
  it('MarketDataModule exports DailyBackfillWorker (so the @Optional dep resolves)', () => {
    const exportsList = Reflect.getMetadata('exports', MarketDataModule) as unknown[];
    expect(exportsList).toContain(DailyBackfillWorker);
  });

  it('waits (bounded) on the shared promise and never starts its own universe pass', async () => {
    const waitForBootBackfill = jest.fn().mockResolvedValue(true);
    const backfillUniverseAtBoot = jest.fn();
    const cron = new LevelBookCron({} as any, {} as any, { waitForBootBackfill, backfillUniverseAtBoot } as any);
    (cron as any).seedSession = jest.fn().mockResolvedValue(undefined);
    (cron as any).lockOpeningRange = jest.fn().mockResolvedValue(undefined);

    await (cron as any).seedAtBoot();

    expect(waitForBootBackfill).toHaveBeenCalledWith(LEVEL_BOOK_BACKFILL_WAIT_MS);
    expect(Number.isFinite(LEVEL_BOOK_BACKFILL_WAIT_MS)).toBe(true);
    expect(backfillUniverseAtBoot).not.toHaveBeenCalled();
  });
});
