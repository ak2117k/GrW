import { Test } from '@nestjs/testing';
import { AnandPriceMonitorService } from '../anand-price-monitor.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { ReinvestmentService } from '../reinvestment.service';
import { ExitPriceService } from '../../../signal-generator/services/exit-price.service';

const makeEntry = (overrides: Partial<{
  id: string; symbol: string; token: string; entryPrice: number;
  targetPct: number; stopPct: number; status: string;
  trailing: boolean; peakPrice: number | null;
  partialBookedAt: Date | null; stopMovedToBE: boolean;
}> = {}) => ({
  id: 'i1', symbol: 'RELIANCE', token: '2885', entryPrice: 2500,
  targetPct: 5, stopPct: 5, status: 'WATCHING', exitPrice: null, exitedAt: null,
  trailing: false, peakPrice: null,
  partialBookedAt: null, stopMovedToBE: false,
  ...overrides,
});

describe('AnandPriceMonitorService', () => {
  let service: AnandPriceMonitorService;
  let repo: {
    listWatchingIntraday: jest.Mock;
    listWatchingSwing: jest.Mock;
    updateIntradayStatus: jest.Mock;
    updateSwingStatus: jest.Mock;
    setIntradayTrailing: jest.Mock;
    recordIntradayPartial: jest.Mock;
    listOpenReinvestmentLots: jest.Mock;
    resolveTokens: jest.Mock;
  };
  let adapter: { getLtpsBatch: jest.Mock; getHistoricalData: jest.Mock };
  let reinvest: { onSwingTargetHit: jest.Mock; closeLot: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  beforeEach(async () => {
    repo = {
      listWatchingIntraday: jest.fn().mockResolvedValue([]),
      listWatchingSwing: jest.fn().mockResolvedValue([]),
      updateIntradayStatus: jest.fn().mockResolvedValue(undefined),
      updateSwingStatus: jest.fn().mockResolvedValue(undefined),
      setIntradayTrailing: jest.fn().mockResolvedValue(undefined),
      recordIntradayPartial: jest.fn().mockResolvedValue(undefined),
      listOpenReinvestmentLots: jest.fn().mockResolvedValue([]),
      resolveTokens: jest.fn().mockResolvedValue(new Map()),
    };
    adapter = {
      getLtpsBatch: jest.fn().mockResolvedValue(new Map()),
      getHistoricalData: jest.fn().mockResolvedValue([]),
    };
    reinvest = {
      onSwingTargetHit: jest.fn().mockResolvedValue(undefined),
      closeLot: jest.fn().mockResolvedValue(undefined),
    };
    // Default: delegate to the adapter batch fixture and wrap every returned
    // price as fresh, so existing `adapter.getLtpsBatch.mockResolvedValue(...)`
    // tests keep driving the fresh-price path through the new service.
    exitPrice = {
      resolveExitPrices: jest.fn(async (_exchange: string, tokens: string[]) => {
        const batch: Map<string, number> = await adapter.getLtpsBatch('NSE', tokens);
        const out = new Map();
        for (const t of tokens) {
          const p = batch.get(t);
          out.set(
            t,
            p != null && p > 0
              ? { price: p, fresh: true, source: 'rest-batch' as const }
              : { price: 0, fresh: false, source: 'none' as const },
          );
        }
        return out;
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandPriceMonitorService,
        { provide: AnandDualTrackRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: ReinvestmentService, useValue: reinvest },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();

    service = mod.get(AnandPriceMonitorService);
  });

  it('arms trailing (not TARGET_HIT) when intraday first reaches +5%', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, targetPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2625]])); // +5%
    await service.pollMarketHours();
    expect(repo.setIntradayTrailing).toHaveBeenCalledWith('i1', { trailing: true, peakPrice: 2625 });
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  it('exits trailing intraday TARGET_HIT via give-back when ST unavailable', async () => {
    // Already trailing with peak 2700; -2% give-back = 2646; 2640 < 2646 → exit.
    repo.listWatchingIntraday.mockResolvedValue([
      makeEntry({ entryPrice: 2500, targetPct: 5, trailing: true, peakPrice: 2700 }),
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2640]]));
    adapter.getHistoricalData.mockResolvedValue([]); // no candles → ST null
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 2640, exitReason: 'TRAIL_GB' }),
    );
  });

  it('marks intraday entry STOPPED when ltp <= entryPrice * 0.95', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, stopPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2374]])); // -5.04%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'STOPPED' }));
  });

  it('does not update status when price is within range', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2530]])); // +1.2%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  it('marks swing entry TARGET_HIT when ltp >= entryPrice * 1.10', async () => {
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]])); // +10%
    await service.pollMarketHours();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 3300 }));
    expect(reinvest.onSwingTargetHit).toHaveBeenCalledWith({ swingEntryId: 's1', symbol: 'RELIANCE', exitPrice: 3300 });
  });

  it('expireIntradayAtClose marks each entry EXPIRED at its last traded price', async () => {
    repo.listWatchingIntraday.mockResolvedValue([
      makeEntry({ id: 'i1', token: '2885', entryPrice: 2500 }),
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2550]])); // +2% at close
    await service.expireIntradayAtClose();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({ status: 'EXPIRED', exitPrice: 2550 }),
    );
  });

  it('expireIntradayAtClose falls back to entryPrice (breakeven) when no LTP', async () => {
    repo.listWatchingIntraday.mockResolvedValue([
      makeEntry({ id: 'i2', token: '9999', entryPrice: 2500 }),
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map()); // no price available
    await service.expireIntradayAtClose();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith(
      'i2',
      expect.objectContaining({ status: 'EXPIRED', exitPrice: 2500 }),
    );
  });

  it('pollOvernight only processes swing entries', async () => {
    // Freeze clock to 20:30 IST (15:00 UTC) — outside market hours so the
    // guard does not return early.
    jest.useFakeTimers({ now: new Date('2026-06-03T14:30:00Z') });
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]]));
    await service.pollOvernight();
    jest.useRealTimers();
    expect(repo.listWatchingIntraday).not.toHaveBeenCalled();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT' }));
  });

  it('does NOT fire a swing stop and warns when the resolved price is not fresh', async () => {
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    repo.listWatchingSwing.mockResolvedValue([
      makeEntry({ id: 's1', symbol: 'RELIANCE', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 }),
    ]);
    // Price would be a clear stop (-20%), but the resolver reports it stale —
    // the stop MUST NOT be evaluated, and the position must be surfaced.
    exitPrice.resolveExitPrices.mockResolvedValue(
      new Map([['2885', { price: 2400, fresh: false, source: 'none' as const }]]),
    );
    await service.pollMarketHours();
    expect(repo.updateSwingStatus).not.toHaveBeenCalled();
    expect(reinvest.onSwingTargetHit).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unmonitored — no fresh price'));
    warnSpy.mockRestore();
  });

  it('skips token not found in ltp map', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ token: 'unknown' })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map()); // empty
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  // --- Partial profit-booking (50% @ +3%, stop → breakeven) ---

  describe('decideIntradayTrail breakeven stop', () => {
    const base = {
      entryPrice: 100, targetPct: 5, stopPct: 5,
      trailing: false, peakPrice: null as number | null, stopMovedToBE: false,
    };

    it('STOPS at breakeven (pnl −0.5%) when stopMovedToBE is true (not trailing)', () => {
      const d = AnandPriceMonitorService.decideIntradayTrail(
        { ...base, stopMovedToBE: true },
        99.5, // −0.5%
        null,
      );
      expect(d.action).toBe('STOP');
    });

    it('HOLDS at the same −0.5% price when stopMovedToBE is false (−0.5% > −5%)', () => {
      const d = AnandPriceMonitorService.decideIntradayTrail(
        { ...base, stopMovedToBE: false },
        99.5,
        null,
      );
      expect(d.action).toBe('HOLD');
    });

    it('STOPS a trailing runner once ltp drops to/below entryPrice when BE moved', () => {
      const d = AnandPriceMonitorService.decideIntradayTrail(
        { ...base, trailing: true, peakPrice: 108, stopMovedToBE: true },
        99.9, // below entry 100
        95,   // would otherwise HOLD (above ST line)
      );
      expect(d.action).toBe('STOP');
    });

    it('still ARM_TRAILs at >= targetPct regardless of stopMovedToBE', () => {
      const d = AnandPriceMonitorService.decideIntradayTrail(
        { ...base, stopMovedToBE: true },
        105, // +5%
        null,
      );
      expect(d).toEqual({ action: 'ARM_TRAIL', peakPrice: 105 });
    });
  });

  it('books 50% partial + moves stop to BE at +3.5% without closing the entry', async () => {
    repo.listWatchingIntraday.mockResolvedValue([
      makeEntry({ entryPrice: 2500, partialBookedAt: null }),
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2587.5]])); // +3.5%
    await service.pollMarketHours();

    expect(repo.recordIntradayPartial).toHaveBeenCalledTimes(1);
    expect(repo.recordIntradayPartial).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({
        partialExitPrice: 2587.5,
        partialFraction: 0.5,
        stopMovedToBE: true,
      }),
    );
    // Booking does not close the position (it is still WATCHING, no stop yet).
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  it('does NOT re-book the partial when partialBookedAt is already set (idempotent)', async () => {
    repo.listWatchingIntraday.mockResolvedValue([
      makeEntry({ entryPrice: 2500, partialBookedAt: new Date(), stopMovedToBE: true }),
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2600]])); // +4%
    await service.pollMarketHours();

    expect(repo.recordIntradayPartial).not.toHaveBeenCalled();
  });
});
