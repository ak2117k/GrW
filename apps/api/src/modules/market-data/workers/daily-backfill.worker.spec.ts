import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DailyBackfillWorker } from './daily-backfill.worker';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import { AngelOneAuthService, BOOT_SESSION_WAIT_MS } from '../services/angel-one-auth.service';
import { MarketDataRepository } from '../repositories/market-data.repository';

describe('DailyBackfillWorker.onModuleInit (boot catch-up)', () => {
  let worker: DailyBackfillWorker;
  let prisma: { instrument: { findFirst: jest.Mock }; candle: { findFirst: jest.Mock } };
  let adapter: { getHistoricalData: jest.Mock };
  let auth: { whenAuthenticated: jest.Mock };
  let repo: { saveCandles: jest.Mock };

  beforeEach(async () => {
    prisma = {
      instrument: { findFirst: jest.fn().mockResolvedValue(null) },
      candle: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    adapter = { getHistoricalData: jest.fn().mockResolvedValue([]) };
    auth = { whenAuthenticated: jest.fn().mockResolvedValue(true) };
    repo = { saveCandles: jest.fn().mockResolvedValue(0) };

    const module = await Test.createTestingModule({
      providers: [
        DailyBackfillWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: AngelOneAuthService, useValue: auth },
        { provide: MarketDataRepository, useValue: repo },
      ],
    }).compile();
    module.useLogger(false);
    worker = module.get(DailyBackfillWorker);
    // Inter-target pacing is real 1.2s timers — irrelevant to these contracts.
    jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);
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

  /**
   * Production boot 2026-10-12: this pass hit the broker ~1s after container
   * start, before the detached feed login had built the SmartAPI client, and
   * failed with "Cannot read properties of null (reading 'getCandleData')".
   */
  describe('waits for the broker session before touching the broker', () => {
    beforeEach(() => {
      prisma.instrument.findFirst.mockResolvedValue({ id: 'inst-1', token: '99926000' });
    });

    it('waits (bounded) on the feed session before the first broker call', async () => {
      const order: string[] = [];
      auth.whenAuthenticated.mockImplementation(async () => {
        order.push('session-ready');
        return true;
      });
      adapter.getHistoricalData.mockImplementation(async () => {
        order.push('broker-call');
        return [];
      });

      await worker.backfillUniverseAtBoot();

      expect(auth.whenAuthenticated).toHaveBeenCalledWith(BOOT_SESSION_WAIT_MS);
      expect(Number.isFinite(BOOT_SESSION_WAIT_MS)).toBe(true);
      expect(order[0]).toBe('session-ready');
      expect(adapter.getHistoricalData).toHaveBeenCalled();
    });

    it('skips and defers to the scheduled crons with ONE clear log line when no session arrives', async () => {
      auth.whenAuthenticated.mockResolvedValue(false);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await worker.backfillUniverseAtBoot();

      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      const skipLines = warn.mock.calls.filter(([m]) => /skipp/i.test(String(m)));
      expect(skipLines).toHaveLength(1);
      expect(String(skipLines[0][0])).toMatch(/session/i);
      warn.mockRestore();
      error.mockRestore();
    });

    it('the scheduled crons do not wait (they fire long after boot)', async () => {
      await worker.runEquityBackfill();
      expect(auth.whenAuthenticated).not.toHaveBeenCalled();
      expect(adapter.getHistoricalData).toHaveBeenCalled();
    });
  });
});
