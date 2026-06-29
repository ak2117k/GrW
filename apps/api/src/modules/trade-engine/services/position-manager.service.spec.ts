import { Test, TestingModule } from '@nestjs/testing';
import { PositionManagerService } from './position-manager.service';
import {
  BROKER_ADAPTER_TOKEN,
  MarketFeedService,
} from '../../market-data/services/market-feed.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import { RiskManagerService } from './risk-manager.service';

/**
 * A partial close must shrink the in-memory position, not leave it at the
 * original quantity — a stale 2x size feeds the risk engine and get_positions.
 */
describe('PositionManagerService.reducePosition — partial-close tracking', () => {
  let svc: PositionManagerService;

  beforeEach(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PositionManagerService,
        { provide: BROKER_ADAPTER_TOKEN, useValue: null },
        { provide: MarketFeedService, useValue: {} },
        { provide: TradeRepository, useValue: { getOpenTrades: jest.fn().mockResolvedValue([]) } },
        { provide: TradeGateway, useValue: {} },
        { provide: RiskManagerService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(PositionManagerService);
  });

  function seed() {
    svc.addPosition('t1', {
      symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      quantity: 200, averagePrice: 100, positionType: 'INTRADAY',
    });
  }

  it('shrinks the tracked quantity by the closed slice', () => {
    seed();
    svc.reducePosition('t1', 120, 600);
    expect(svc.getPositions()[0].quantity).toBe(80); // 200 - 120
  });

  it('removes the position entirely when the reduction reaches zero', () => {
    seed();
    svc.reducePosition('t1', 200, 1000);
    expect(svc.getPositions()).toHaveLength(0);
  });
});
