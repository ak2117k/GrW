import { Test } from '@nestjs/testing';
import { DailyBackfillWorker } from './daily-backfill.worker';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import { MarketDataRepository } from '../repositories/market-data.repository';

describe('DailyBackfillWorker.onModuleInit (boot catch-up)', () => {
  let worker: DailyBackfillWorker;
  let prisma: { instrument: { findFirst: jest.Mock }; candle: { findFirst: jest.Mock } };
  let adapter: { getHistoricalData: jest.Mock };
  let repo: { saveCandles: jest.Mock };

  beforeEach(async () => {
    prisma = {
      instrument: { findFirst: jest.fn().mockResolvedValue(null) },
      candle: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    adapter = { getHistoricalData: jest.fn().mockResolvedValue([]) };
    repo = { saveCandles: jest.fn().mockResolvedValue(0) };

    const module = await Test.createTestingModule({
      providers: [
        DailyBackfillWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: MarketDataRepository, useValue: repo },
      ],
    }).compile();
    module.useLogger(false);
    worker = module.get(DailyBackfillWorker);
  });

  it('runs backfillUniverseAtBoot() on module init (closes the missed-cron gap)', async () => {
    const spy = jest
      .spyOn(worker, 'backfillUniverseAtBoot')
      .mockResolvedValue();
    await worker.onModuleInit();
    // onModuleInit is fire-and-forget — wait one microtask flush so the
    // unawaited promise has a chance to register the call.
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not throw or crash module init when boot backfill rejects', async () => {
    jest
      .spyOn(worker, 'backfillUniverseAtBoot')
      .mockRejectedValue(new Error('broker timeout'));
    // Should resolve cleanly — the .catch() inside onModuleInit absorbs the error.
    await expect(worker.onModuleInit()).resolves.toBeUndefined();
    // Flush microtasks so the rejected promise + catch handler complete before
    // the test ends; otherwise jest reports an unhandled rejection.
    await new Promise((r) => setImmediate(r));
  });
});
