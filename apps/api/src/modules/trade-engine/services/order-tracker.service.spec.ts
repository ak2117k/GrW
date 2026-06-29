import { Test, TestingModule } from '@nestjs/testing';
import { OrderTrackerService } from './order-tracker.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';

/**
 * Covers the ASYNC order-book REJECTED path enrichment: a surveillance /
 * cautionary / delivery-only (T2T) rejection surfaced via the order book
 * must be persisted with an actionable hint, while ordinary rejections
 * (margin, quantity) pass through untouched.
 */
describe('OrderTrackerService.handleOrderRejected — cautionary enrichment', () => {
  let module: TestingModule;
  let service: OrderTrackerService;
  let repo: { updateTrade: jest.Mock; getTradeById: jest.Mock };
  let gateway: { emitTradeUpdate: jest.Mock };

  const REAL_REJECTION =
    'The order cannot be processed as the token is categorised under ' +
    'cautionary listings by the exchange.';

  beforeEach(async () => {
    repo = {
      updateTrade: jest.fn(async () => ({})),
      getTradeById: jest.fn(async () => ({ id: 'trade_1', status: 'REJECTED' })),
    };
    gateway = { emitTradeUpdate: jest.fn() };

    module = await Test.createTestingModule({
      providers: [
        OrderTrackerService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: null },
        { provide: TradeRepository, useValue: repo },
        { provide: TradeGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(OrderTrackerService);
  });

  it('enriches a cautionary rejection note with the DELIVERY hint', async () => {
    await (service as any).handleOrderRejected(
      { orderId: 'o1', tradeId: 'trade_1' },
      { text: REAL_REJECTION },
    );

    expect(repo.updateTrade).toHaveBeenCalledWith('trade_1', {
      status: 'REJECTED',
      notes: expect.stringContaining('Switch Product to DELIVERY'),
    });
    expect(gateway.emitTradeUpdate).toHaveBeenCalled();
  });

  it('reads the rejectionreason field when text is absent', async () => {
    await (service as any).handleOrderRejected(
      { orderId: 'o2', tradeId: 'trade_1' },
      { rejectionreason: 'Order not allowed in this product' },
    );

    const notes = repo.updateTrade.mock.calls[0][1].notes as string;
    expect(notes).toContain('Switch Product to DELIVERY');
  });

  it('leaves an ordinary rejection note untouched (no hint)', async () => {
    await (service as any).handleOrderRejected(
      { orderId: 'o3', tradeId: 'trade_1' },
      { text: 'RMS: margin shortfall' },
    );

    expect(repo.updateTrade).toHaveBeenCalledWith('trade_1', {
      status: 'REJECTED',
      notes: 'Rejected: RMS: margin shortfall',
    });
    const notes = repo.updateTrade.mock.calls[0][1].notes as string;
    expect(notes).not.toContain('Switch Product to DELIVERY');
  });
});
