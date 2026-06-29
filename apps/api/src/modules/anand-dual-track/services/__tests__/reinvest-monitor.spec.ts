import { AnandPriceMonitorService } from '../anand-price-monitor.service';

describe('checkReinvestmentLots', () => {
  it('closes a lot that reached +10%', async () => {
    const reinvest = { closeLot: jest.fn(async () => {}), onSwingTargetHit: jest.fn() };
    const repo = {
      listOpenReinvestmentLots: jest.fn(async () => [{ id: 'lot1', symbol: 'TCS', entryPrice: 100, capital: 20000, targetPct: 10, stopPct: 10 }]),
      resolveTokens: jest.fn(async () => new Map([['TCS', 't1']])),
    };
    const adapter = { getLtpsBatch: jest.fn(async () => new Map([['t1', 111]])) };
    const exitPrice = {
      resolveExitPrices: jest.fn(async () => new Map([['t1', { price: 111, fresh: true, source: 'rest-batch' as const }]])),
    };
    const svc = new AnandPriceMonitorService(repo as any, adapter as any, reinvest as any, exitPrice as any);
    await (svc as any).checkReinvestmentLots();
    expect(reinvest.closeLot).toHaveBeenCalledWith(
      { id: 'lot1', capital: 20000, entryPrice: 100 }, 111, 'TARGET_HIT',
    );
  });
});
