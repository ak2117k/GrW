import { Test, TestingModule } from '@nestjs/testing';
import { OpenPaperTradeRefresherWorker, isContractExpired } from './open-paper-trade-refresher.worker';
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

  let chain: { getOptionsChainWithSpot: jest.Mock; getLiveOptionLtp: jest.Mock };

  function optionTrade(status: string, expiry: Date = new Date('2099-05-28')) {
    return {
      id: 't1', isPaperTrade: true, status, side: 'BUY',
      quantity: 50, entryPrice: 150, pnl: 500,
      instrument: {
        name: 'NIFTY', segment: 'OPTIONS',
        expiry, strike: 22500, optionType: 'CE',
      },
    };
  }

  beforeEach(async () => {
    tradeRepo = {
      getOpenTrades: jest.fn(),
      updateTrade: jest.fn().mockResolvedValue({}),
    };
    chain = {
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

  it('skips an option trade whose contract has expired — no chain fetch for a dead expiry', async () => {
    // Regression: an OPEN paper CRUDEOIL trade on the 2026-10-15 expiry made
    // the refresher request that expired chain every 30 s.
    tradeRepo.getOpenTrades.mockResolvedValue([optionTrade('OPEN', new Date('2020-10-15'))]);

    await worker.refreshLoop();

    expect(chain.getOptionsChainWithSpot).not.toHaveBeenCalled();
    expect(chain.getLiveOptionLtp).not.toHaveBeenCalled();
    expect(tradeRepo.updateTrade).not.toHaveBeenCalled();
  });
});

describe('isContractExpired', () => {
  const now = new Date('2026-10-22T06:00:00Z'); // 11:30 IST, 22 Oct

  it('is false on the expiry day itself, including an IST-midnight timestamp', () => {
    expect(isContractExpired(new Date('2026-10-22T00:00:00Z'), now)).toBe(false);
    // IST midnight of 22 Oct is 21 Oct 18:30 UTC — still the 22nd in IST.
    expect(isContractExpired(new Date('2026-10-21T18:30:00Z'), now)).toBe(false);
  });

  it('is true for a date before today and false for a future one', () => {
    expect(isContractExpired(new Date('2026-10-15T00:00:00Z'), now)).toBe(true);
    expect(isContractExpired(new Date('2026-10-27T00:00:00Z'), now)).toBe(false);
  });
});
