import { Test, TestingModule } from '@nestjs/testing';
import { TradeEngineController } from './trade-engine.controller';
import { TradeExecutionService } from '../services/trade-execution.service';
import { PositionManagerService } from '../services/position-manager.service';
import { RiskManagerService } from '../services/risk-manager.service';
import { PaperTradeService } from '../services/paper-trade.service';
import { TradeRepository } from '../repositories/trade.repository';

/**
 * Endpoint spec for GET /api/trades/:id/events — the per-trade event log.
 * The repository is mocked; we assert the controller delegates to
 * TradeRepository.getTradeEvents and returns its result newest-first.
 */
describe('TradeEngineController — GET :id/events', () => {
  let controller: TradeEngineController;
  let repo: { getTradeEvents: jest.Mock };

  const sampleEvents = [
    { id: 'evt_3', tradeId: 'trade_1', eventType: 'CLOSED', price: 130.5, quantity: 50, pnl: 1525, notes: 'HIT_TARGET', createdAt: new Date('2026-06-17T10:00:00Z') },
    { id: 'evt_2', tradeId: 'trade_1', eventType: 'FILLED', price: 100, quantity: 50, pnl: null, notes: null, createdAt: new Date('2026-06-17T09:00:00Z') },
    { id: 'evt_1', tradeId: 'trade_1', eventType: 'CREATED', price: 100, quantity: 50, pnl: null, notes: 'paper MARKET BUY', createdAt: new Date('2026-06-17T09:00:00Z') },
  ];

  beforeEach(async () => {
    repo = { getTradeEvents: jest.fn(async () => sampleEvents) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TradeEngineController],
      providers: [
        { provide: TradeExecutionService, useValue: {} },
        { provide: PositionManagerService, useValue: {} },
        { provide: RiskManagerService, useValue: {} },
        { provide: PaperTradeService, useValue: {} },
        { provide: TradeRepository, useValue: repo },
      ],
    }).compile();

    controller = module.get(TradeEngineController);
  });

  it('returns the trade events newest-first via the repository', async () => {
    const result = await controller.getTradeEvents('trade_1');

    expect(repo.getTradeEvents).toHaveBeenCalledWith('trade_1');
    expect(result).toHaveLength(3);
    expect(result[0].eventType).toBe('CLOSED');
    expect(result[2].eventType).toBe('CREATED');
  });
});
