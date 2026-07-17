import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioService } from './portfolio.service';
import { PortfolioRepository } from '../repositories/portfolio.repository';

/**
 * Unit tests for PortfolioService.getChartTrades — the chart-trade annotation
 * contract (docs/superpowers/specs/2026-07-17-chart-trade-annotations-design.md §2).
 *
 * The real logic under test is the SHAPING of Trade + TradeEvent rows into the
 * fixed { trades: ChartTrade[] } contract: entry resolution (FILLED event vs.
 * Trade fallback), cumulative quantity-remaining maths across multiple exits,
 * and provenance derivation. The repository (the Prisma query) is mocked.
 */
describe('PortfolioService — getChartTrades', () => {
  let module: TestingModule;
  let service: PortfolioService;
  let getTradesWithEventsByToken: jest.Mock;

  const build = async () => {
    module = await Test.createTestingModule({
      providers: [
        PortfolioService,
        {
          provide: PortfolioRepository,
          useValue: { getTradesWithEventsByToken },
        },
      ],
    }).compile();
    service = module.get(PortfolioService);
  };

  // Convenience for deterministic, ordered timestamps.
  const at = (min: number) => new Date(Date.UTC(2026, 6, 17, 9, min, 0));

  beforeEach(() => {
    getTradesWithEventsByToken = jest.fn();
  });

  it('returns { trades: [] } when there are no trades for the token', async () => {
    getTradesWithEventsByToken.mockResolvedValue([]);
    await build();

    const result = await service.getChartTrades('99999');

    expect(result).toEqual({ trades: [] });
    expect(getTradesWithEventsByToken).toHaveBeenCalledWith('99999');
  });

  it('computes cumulative quantityRemaining across two PARTIAL_EXITs', async () => {
    getTradesWithEventsByToken.mockResolvedValue([
      {
        id: 'trade-1',
        side: 'BUY',
        source: 'MANUAL',
        strategy: null,
        quantity: 100,
        entryPrice: 500,
        entryTime: at(0),
        exitReasonTag: null,
        events: [
          // Intentionally out of chronological order to prove sorting.
          { eventType: 'PARTIAL_EXIT', price: 520, quantity: 30, createdAt: at(20) },
          { eventType: 'FILLED', price: 500, quantity: 100, createdAt: at(0) },
          { eventType: 'PARTIAL_EXIT', price: 510, quantity: 40, createdAt: at(10) },
        ],
      },
    ]);
    await build();

    const { trades } = await service.getChartTrades('123');

    expect(trades).toHaveLength(1);
    expect(trades[0].entry).toEqual({ time: at(0).getTime(), price: 500, quantity: 100 });
    expect(trades[0].exits).toEqual([
      {
        time: at(10).getTime(),
        price: 510,
        quantitySold: 40,
        quantityRemaining: 60,
        reason: 'PARTIAL_EXIT',
      },
      {
        time: at(20).getTime(),
        price: 520,
        quantitySold: 30,
        quantityRemaining: 30,
        reason: 'PARTIAL_EXIT',
      },
    ]);
  });

  it('treats a CLOSED event with null quantity as selling the remaining (remaining → 0)', async () => {
    getTradesWithEventsByToken.mockResolvedValue([
      {
        id: 'trade-2',
        side: 'BUY',
        source: 'AUTO',
        strategy: 'RSI',
        quantity: 100,
        entryPrice: 500,
        entryTime: at(0),
        exitReasonTag: 'HIT_TARGET',
        events: [
          { eventType: 'FILLED', price: 500, quantity: 100, createdAt: at(0) },
          { eventType: 'PARTIAL_EXIT', price: 510, quantity: 40, createdAt: at(10) },
          { eventType: 'CLOSED', price: 520, quantity: null, createdAt: at(20) },
        ],
      },
    ]);
    await build();

    const { trades } = await service.getChartTrades('123');

    expect(trades[0].exits).toEqual([
      {
        time: at(10).getTime(),
        price: 510,
        quantitySold: 40,
        quantityRemaining: 60,
        reason: 'PARTIAL_EXIT',
      },
      {
        time: at(20).getTime(),
        price: 520,
        quantitySold: 60,
        quantityRemaining: 0,
        reason: 'HIT_TARGET', // CLOSED uses exitReasonTag when present
      },
    ]);
  });

  it('falls back to Trade entryTime/entryPrice/quantity when there is no FILLED event', async () => {
    getTradesWithEventsByToken.mockResolvedValue([
      {
        id: 'trade-3',
        side: 'SELL',
        source: 'MANUAL',
        strategy: null,
        quantity: 50,
        entryPrice: 250,
        entryTime: at(0),
        exitReasonTag: null,
        events: [
          { eventType: 'SL_HIT', price: 240, quantity: 50, createdAt: at(15) },
        ],
      },
    ]);
    await build();

    const { trades } = await service.getChartTrades('123');

    expect(trades[0].entry).toEqual({ time: at(0).getTime(), price: 250, quantity: 50 });
    expect(trades[0].exits[0]).toEqual({
      time: at(15).getTime(),
      price: 240,
      quantitySold: 50,
      quantityRemaining: 0,
      reason: 'SL_HIT',
    });
  });

  it('yields entry = null when neither a FILLED event nor Trade fields give a time + price', async () => {
    getTradesWithEventsByToken.mockResolvedValue([
      {
        id: 'trade-4',
        side: 'BUY',
        source: 'MANUAL',
        strategy: null,
        quantity: 10,
        entryPrice: null,
        entryTime: null,
        exitReasonTag: null,
        events: [],
      },
    ]);
    await build();

    const { trades } = await service.getChartTrades('123');

    expect(trades[0].entry).toBeNull();
    expect(trades[0].exits).toEqual([]);
  });

  describe('provenance derivation', () => {
    const tradeWith = (source: string, strategy: string | null) => ({
      id: `t-${source}-${strategy}`,
      side: 'BUY',
      source,
      strategy,
      quantity: 10,
      entryPrice: 100,
      entryTime: at(0),
      exitReasonTag: null,
      events: [],
    });

    it('maps a chartink SCANNER/AUTO strategy to "Chartink (<strategy>)"', async () => {
      getTradesWithEventsByToken.mockResolvedValue([
        tradeWith('SCANNER', 'chartink-gated'),
        tradeWith('AUTO', 'Chartink-Breakout'),
      ]);
      await build();

      const { trades } = await service.getChartTrades('123');
      expect(trades[0].provenance).toBe('Chartink (chartink-gated)');
      expect(trades[1].provenance).toBe('Chartink (Chartink-Breakout)');
    });

    it('maps MANUAL to "Manual"', async () => {
      getTradesWithEventsByToken.mockResolvedValue([tradeWith('MANUAL', null)]);
      await build();

      const { trades } = await service.getChartTrades('123');
      expect(trades[0].provenance).toBe('Manual');
    });

    it('maps AUTO with a non-chartink strategy to "Signal: <strategy>"', async () => {
      getTradesWithEventsByToken.mockResolvedValue([tradeWith('AUTO', 'RSI')]);
      await build();

      const { trades } = await service.getChartTrades('123');
      expect(trades[0].provenance).toBe('Signal: RSI');
    });

    it('falls back to the raw source otherwise', async () => {
      getTradesWithEventsByToken.mockResolvedValue([tradeWith('WATCH', null)]);
      await build();

      const { trades } = await service.getChartTrades('123');
      expect(trades[0].provenance).toBe('WATCH');
    });
  });
});
