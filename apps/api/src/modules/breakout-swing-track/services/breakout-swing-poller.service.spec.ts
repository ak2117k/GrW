import { Test } from '@nestjs/testing';
import { BreakoutSwingPollerService } from './breakout-swing-poller.service';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NOTIONAL, INIT_STOP_PCT, TRAIL_GIVEBACK_PCT } from '../constants';

describe('BreakoutSwingPollerService.decideTradedTick (pure)', () => {
  const base = { entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null };

  it('TARGET_HIT at +10%', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 110, false)).toEqual({ action: 'TARGET_HIT' });
  });

  it('HOLD when between stop and target and not yet up 7%', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 103, false)).toEqual({ action: 'HOLD' });
  });

  it('STOPPED on the initial hard stop while not trailing', () => {
    expect(BreakoutSwingPollerService.decideTradedTick(base, 90, false)).toEqual({ action: 'STOPPED' });
  });

  it('arms the trailing stop once up +7% (RATCHET_TRAIL, stop = highWater × (1−giveback))', () => {
    const d = BreakoutSwingPollerService.decideTradedTick(base, 107.5, false);
    expect(d.action).toBe('RATCHET_TRAIL');
    if (d.action === 'RATCHET_TRAIL') {
      expect(d.highWater).toBe(107.5);
      expect(d.stopPrice).toBeCloseTo(107.5 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    }
  });

  it('ratchets the trailing stop UP on a new high-water (still below the +10% target)', () => {
    const trailing = { ...base, trailing: true, trailingHighWater: 107.5, stopPrice: 107.5 * (1 - TRAIL_GIVEBACK_PCT / 100) };
    // 109 is +9% (below the +10% target) and a new high-water → ratchet up.
    const d = BreakoutSwingPollerService.decideTradedTick(trailing, 109, false);
    expect(d.action).toBe('RATCHET_TRAIL');
    if (d.action === 'RATCHET_TRAIL') {
      expect(d.highWater).toBe(109);
      expect(d.stopPrice).toBeCloseTo(109 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    }
  });

  it('trailing stop fires (STOPPED) when price falls below the trailed stop — REPLACES the −10% stop', () => {
    const hw = 110;
    const trailStop = hw * (1 - TRAIL_GIVEBACK_PCT / 100); // 107.8
    const trailing = { ...base, trailing: true, trailingHighWater: hw, stopPrice: trailStop };
    // 108 is well above the −10% hard stop (90) but below the trailed stop → STOPPED.
    expect(BreakoutSwingPollerService.decideTradedTick(trailing, 107, false)).toEqual({ action: 'STOPPED' });
  });

  it('BIG_MOVER_EOD locks a trade up > 7% FROM ENTRY inside the EOD window', () => {
    // +8% from entry (100 → 108), inside the window → lock the gain.
    expect(BreakoutSwingPollerService.decideTradedTick(base, 108, true)).toEqual({ action: 'BIG_MOVER_EOD' });
    // Same gain OUTSIDE the window → not a forced exit (trailing manages it).
    expect(BreakoutSwingPollerService.decideTradedTick(base, 108, false).action).not.toBe('BIG_MOVER_EOD');
  });

  it('no BIG_MOVER_EOD when the trade is up ≤ 7% from entry — even if the STOCK is way up on the day', () => {
    // Stock +28% on the day (prevClose 80 → 103) but the TRADE is only +3% from
    // entry: HELD, not force-exited. The old prev-close basis would have
    // force-exited this at a tiny gain — exactly the bug this fix removes.
    const e = { ...base, prevDayClose: 80 };
    expect(BreakoutSwingPollerService.decideTradedTick(e, 103, true)).toEqual({ action: 'HOLD' });
  });
});

describe('BreakoutSwingPollerService — poller integration', () => {
  let svc: BreakoutSwingPollerService;
  let repo: any;
  let adapter: any;

  beforeEach(async () => {
    repo = {
      listQueued: jest.fn().mockResolvedValue([]),
      listTraded: jest.fn().mockResolvedValue([]),
      fill: jest.fn().mockResolvedValue(undefined),
      setTrailing: jest.fn().mockResolvedValue(undefined),
      recordTick: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    adapter = { getLtpsBatch: jest.fn(), getLiveQuote: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        BreakoutSwingPollerService,
        { provide: BreakoutSwingRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(BreakoutSwingPollerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fills a QUEUED entry when LTP reaches the resting limit → TRADED with qty + stop', async () => {
    repo.listQueued.mockResolvedValue([
      { id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 101.5]]));

    await svc.pollMarketHours();

    const call = repo.fill.mock.calls[0];
    expect(call[0]).toBe('q1');
    expect(call[1].entryPrice).toBe(101.5);
    expect(call[1].quantity).toBe(Math.floor(NOTIONAL / 101.5));
    expect(call[1].stopPrice).toBeCloseTo(101.5 * (1 - INIT_STOP_PCT / 100), 6);
  });

  it('does NOT fill a QUEUED entry when LTP is below the resting limit', async () => {
    repo.listQueued.mockResolvedValue([
      { id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 100.5]]));

    await svc.pollMarketHours();

    expect(repo.fill).not.toHaveBeenCalled();
    // Still resting, but the live price must be persisted so the UI shows
    // Price + Dist-to-Fill instead of "—".
    expect(repo.recordTick).toHaveBeenCalledWith('q1', expect.objectContaining({ currentPrice: 100.5 }));
  });

  it('persists a QUEUED price via single-quote fallback when the batch drops the token', async () => {
    repo.listQueued.mockResolvedValue([
      { id: 'q1', symbol: 'KIRLPNU', token: '15180', limitPrice: 1817.87 },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map()); // batch silently drops it
    adapter.getLiveQuote.mockResolvedValue({ ltp: 1794.3 });

    await svc.pollMarketHours();

    expect(adapter.getLiveQuote).toHaveBeenCalledWith('15180', 'NSE');
    expect(repo.recordTick).toHaveBeenCalledWith('q1', expect.objectContaining({ currentPrice: 1794.3 }));
    expect(repo.fill).not.toHaveBeenCalled(); // 1794.3 < 1817.87
  });

  it('arms the trailing stop on a TRADED entry once it is up +7%', async () => {
    // Freeze to 11:30 IST (mid-session, before the 15:15 big-mover window) so
    // pollMarketHours()'s real-clock isBigMoverWindow() doesn't force-exit the
    // +13.7%-on-the-day stock before the trailing stop can arm.
    jest.useFakeTimers({ now: new Date('2026-06-12T06:00:00Z') });
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 108]]));

    await svc.pollMarketHours();

    expect(repo.recordTick).toHaveBeenCalledWith('t1', expect.objectContaining({ currentPrice: 108 }));
    const setCall = repo.setTrailing.mock.calls[0];
    expect(setCall[0]).toBe('t1');
    expect(setCall[1].trailingHighWater).toBe(108);
    expect(setCall[1].stopPrice).toBeCloseTo(108 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('big-mover EOD: force-exits a TRADED entry as BIG_MOVER_EOD inside the 15:15 window', async () => {
    // Freeze IST clock to 15:16 so isBigMoverWindow() is true.
    jest.useFakeTimers({ now: new Date('2026-06-12T09:46:00Z') }); // 15:16 IST
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['11536', 108]])); // +8% FROM ENTRY → locked in the window

    await svc.pollMarketHours();

    expect(repo.updateStatus).toHaveBeenCalledWith('t1', expect.objectContaining({
      status: 'BIG_MOVER_EOD', exitPrice: 108,
    }));
    jest.useRealTimers();
  });
});
