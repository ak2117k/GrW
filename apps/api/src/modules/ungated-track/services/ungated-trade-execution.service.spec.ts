import { Test } from '@nestjs/testing';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from './ungated-paper-account.service';

describe('UngatedTradeExecutionService', () => {
  let svc: UngatedTradeExecutionService;
  let trades: any;
  let account: any;

  beforeEach(async () => {
    trades = {
      createTrade: jest.fn(async (d) => ({ id: 'ut1', ...d, status: 'OPEN' })),
      getTradeById: jest.fn(async () => ({
        id: 'ut1', side: 'BUY', quantity: 100, entryPrice: 2000,
        status: 'OPEN', isPaperTrade: true, pnl: null, fees: 40,
      })),
      update: jest.fn(async (id, data) => ({ id, ...data })),
    };
    account = {
      applyEntry: jest.fn(), applyExit: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTradeExecutionService,
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
      ],
    }).compile();
    svc = mod.get(UngatedTradeExecutionService);
  });

  it('openTrade creates row + applies entry to the ledger', async () => {
    await svc.openTrade({
      instrumentId: 'i1', side: 'BUY', quantity: 100, entryPrice: 2000,
      exchange: 'NSE', target: 2040,
    });
    expect(trades.createTrade).toHaveBeenCalledTimes(1);
    expect(account.applyEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000, quantity: 100,
    }));
  });

  it('closeTrade with opts.exitPrice uses that price (not entry/last fallback)', async () => {
    const out = await svc.closeTrade('ut1', { reason: 'sl-loss-cut', exitPrice: 1990 });
    expect(out.exitPrice).toBe(1990);
    // P&L = (1990-2000) * 100 = -1000
    expect(out.pnl).toBeCloseTo(-1000, 2);
    expect(account.applyExit).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000, exitPrice: 1990, quantity: 100, sideMul: 1,
    }));
  });

  it('closeTrade with quantity option closes a partial slice', async () => {
    const out = await svc.closeTrade('ut1', {
      reason: 'partial-exit', quantity: 50, exitPrice: 2050,
    });
    expect(out.status).toBe('PARTIALLY_FILLED');
    expect(account.applyExit).toHaveBeenCalledWith(expect.objectContaining({ quantity: 50 }));
    // First leg: 50 shares @ +2.5% on a 100-share position. pnlPercent is the
    // position-level return on the cost basis closed so far: 2500 / (2000×50).
    expect(out.pnlPercent).toBeCloseTo(2.5, 4);
    expect(out.closedQuantity).toBe(50);
  });

  it('closeTrade blends pnlPercent across legs (cumulative position return, not last leg)', async () => {
    // Position already 50% exited at +5% → pnl 5000, 50 shares closed, 50 remain.
    trades.getTradeById.mockResolvedValue({
      id: 'ut1', side: 'BUY', quantity: 50, entryPrice: 2000,
      status: 'PARTIALLY_FILLED', isPaperTrade: true, pnl: 5000,
      closedQuantity: 50, fees: 40,
    });
    // Close the remaining 50 at +2.5%.
    const out = await svc.closeTrade('ut1', { reason: 'trailing-stop', exitPrice: 2050 });
    // Cumulative pnl = 5000 + (2050-2000)×50 = 7500 over 100 shares @ ₹2000.
    expect(out.pnl).toBeCloseTo(7500, 2);
    expect(out.closedQuantity).toBe(100);
    // Blended return = 7500 / (2000×100) = 3.75% — NOT the final leg's 2.5%.
    expect(out.pnlPercent).toBeCloseTo(3.75, 4);
  });
});
