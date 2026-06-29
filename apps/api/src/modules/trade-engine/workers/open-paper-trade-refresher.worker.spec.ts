import { Test, TestingModule } from '@nestjs/testing';
import { OpenPaperTradeRefresherWorker } from './open-paper-trade-refresher.worker';
import { TradeRepository } from '../repositories/trade.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';

/**
 * The refresher overwrites a trade's `pnl` with a pure mark-to-market figure.
 * For a PARTIALLY_FILLED trade, `pnl` is the REALIZED P&L booked by the
 * partial close — overwriting it erases that realized profit. The refresher
 * must only touch fully-OPEN trades.
 */
describe('OpenPaperTradeRefresherWorker — preserves realized partial P&L', () => {
  let worker: OpenPaperTradeRefresherWorker;
  let tradeRepo: { getOpenTrades: jest.Mock; updateTrade: jest.Mock };

  function optionTrade(status: string) {
    return {
      id: 't1', isPaperTrade: true, status, side: 'BUY',
      quantity: 50, entryPrice: 150, pnl: 500,
      instrument: {
        name: 'NIFTY', segment: 'OPTIONS',
        expiry: new Date('2026-05-29'), strike: 22500, optionType: 'CE',
      },
    };
  }

  beforeEach(async () => {
    tradeRepo = {
      getOpenTrades: jest.fn(),
      updateTrade: jest.fn().mockResolvedValue({}),
    };
    const chain = {
      getOptionsChainWithSpot: jest.fn().mockResolvedValue({
        chain: [{ strikePrice: 22500, ceData: { ltp: 130, delta: 0.5 }, peData: { ltp: 90, delta: -0.5 } }],
        spotPrice: 22000,
      }),
      getLiveOptionLtp: jest.fn().mockResolvedValue(130),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OpenPaperTradeRefresherWorker,
        { provide: TradeRepository, useValue: tradeRepo },
        { provide: OptionsChainService, useValue: chain },
        { provide: MarketFeedService, useValue: { getQuote: jest.fn(() => null) } },
      ],
    }).compile();
    worker = mod.get(OpenPaperTradeRefresherWorker);
  });

  it('does NOT overwrite a PARTIALLY_FILLED trade — its pnl is realized, not unrealized', async () => {
    tradeRepo.getOpenTrades.mockResolvedValue([optionTrade('PARTIALLY_FILLED')]);

    await worker.refreshLoop();

    expect(tradeRepo.updateTrade).not.toHaveBeenCalled();
  });

  it('still refreshes a fully-OPEN option trade', async () => {
    tradeRepo.getOpenTrades.mockResolvedValue([optionTrade('OPEN')]);

    await worker.refreshLoop();

    expect(tradeRepo.updateTrade).toHaveBeenCalled();
  });
});
