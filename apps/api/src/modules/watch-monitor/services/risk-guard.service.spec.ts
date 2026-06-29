import { Test } from '@nestjs/testing';
import { RiskGuardService } from './risk-guard.service';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService } from './watch.service';

// MAX_INVESTMENT_PER_TRADE = 200_000
// qty(price) = Math.max(1, Math.floor(200_000 / Math.max(price, 1)))

describe('RiskGuardService', () => {
  let svc: RiskGuardService;
  let repo: { findTradedToday: jest.Mock };
  let watch: { squareOffAll: jest.Mock };

  beforeEach(async () => {
    repo = { findTradedToday: jest.fn() };
    watch = { squareOffAll: jest.fn().mockResolvedValue({ watchingClosed: 0, tradedClosed: 0, errors: 0 }) };
    const mod = await Test.createTestingModule({
      providers: [
        RiskGuardService,
        { provide: WatchRepository, useValue: repo },
        { provide: WatchService, useValue: watch },
      ],
    }).compile();
    svc = mod.get(RiskGuardService);
  });

  it('computes total daily P&L across TRADED entries (BUY side)', async () => {
    // A=BUY: executedPrice=100 → qty=2000; pnl = +5 × 2000 = +10,000
    // B=BUY: executedPrice=500 → qty=400;  pnl = -10 × 400  = -4,000
    // total = +6,000
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 100, currentPrice: 105 },
      { symbol: 'B', side: 'BUY', executedPrice: 500, currentPrice: 490 },
    ]);
    const r = await svc.computeDailyPnL();
    expect(r.pnl).toBe(6_000);
    expect(r.breakdown).toHaveLength(2);
  });

  it('uses the real entry.quantity, not the floor(MAX/price) estimate', async () => {
    // executedPrice=100 → the floor(200000/100) estimate would be 2000, but
    // the real filled quantity is 1500. pnl = (105-100)*1500 = +7,500.
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 100, currentPrice: 105, quantity: 1500 },
    ]);
    const r = await svc.computeDailyPnL();
    expect(r.pnl).toBe(7_500);
  });

  it('flips sign for SELL entries (profit when price drops)', async () => {
    // A=SELL: executedPrice=100 → qty=2000; pnl = (95-100)*2000*(-1) = +10,000
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'SELL', executedPrice: 100, currentPrice: 95 },
    ]);
    const r = await svc.computeDailyPnL();
    expect(r.pnl).toBe(10_000);
  });

  it('does NOT trip below loss limit', async () => {
    // A=BUY: executedPrice=1000 → qty=200; pnl = -1 × 200 = -200 (well below 60k)
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 1000, currentPrice: 999 },
    ]);
    expect(await svc.checkAndTrip()).toBe(false);
    expect(watch.squareOffAll).not.toHaveBeenCalled();
  });

  it('TRIPS when cumulative loss <= -₹60,000', async () => {
    // A=BUY: executedPrice=100 → qty=2000; pnl = (70-100)*2000 = -30*2000 = -60,000
    // -60,000 <= -60,000 → breaker trips
    repo.findTradedToday.mockResolvedValue([
      { symbol: 'A', side: 'BUY', executedPrice: 100, currentPrice: 70 },
    ]);
    expect(await svc.checkAndTrip()).toBe(true);
    expect(watch.squareOffAll).toHaveBeenCalledWith('daily-loss-breaker');
  });
});
