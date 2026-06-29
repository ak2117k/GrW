import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the shared axios instance so no real network call happens.
// `vi.hoisted` keeps the spy available inside the hoisted vi.mock factory.
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/services/api', () => ({ default: { get } }));
// toast is invoked from other store actions on import; stub it out.
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import {
  useTradeStore,
  deriveCapitalDeployed,
  derivePositionsCount,
  tradesToPositions,
  overlayLivePrices,
} from './trade-store';
import type { Trade } from '@/types';

function makeTrade(over: Record<string, unknown>): Trade {
  return {
    id: 'T1',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: 10,
    entryPrice: 100,
    ltp: 100,
    pnl: 0,
    pnlPercent: 0,
    status: 'OPEN',
    strategy: 'manual',
    positionType: 'INTRADAY',
    isPaper: true,
    createdAt: new Date(),
    ...over,
  } as Trade;
}

beforeEach(() => {
  get.mockReset();
  useTradeStore.setState({ openTrades: [] });
});

describe('fetchOpenTrades', () => {
  it('sends source=MANUAL when scoped to the manual-trade page', async () => {
    get.mockResolvedValueOnce({ data: [] });
    await useTradeStore.getState().fetchOpenTrades('MANUAL');
    expect(get).toHaveBeenCalledWith('/trades/open', {
      params: { source: 'MANUAL' },
    });
  });

  it('omits the source param when called with no argument (shared consumers)', async () => {
    get.mockResolvedValueOnce({ data: [] });
    await useTradeStore.getState().fetchOpenTrades();
    expect(get).toHaveBeenCalledWith('/trades/open', { params: undefined });
  });

  it('populates openTrades from the response', async () => {
    get.mockResolvedValueOnce({
      data: [{ id: 'A', instrument: { symbol: 'TCS', exchange: 'NSE' } }],
    });
    await useTradeStore.getState().fetchOpenTrades('MANUAL');
    const trades = useTradeStore.getState().openTrades;
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('TCS');
  });
});

describe('derived capital / positions', () => {
  const trades: Trade[] = [
    makeTrade({ id: '1', entryPrice: 100, quantity: 10 }), // 1000
    makeTrade({ id: '2', entryPrice: 250, quantity: 4 }), // 1000
    makeTrade({ id: '3', entryPrice: 50, quantity: 3 }), // 150
  ];

  it('deriveCapitalDeployed sums entryPrice * quantity', () => {
    expect(deriveCapitalDeployed(trades)).toBe(2150);
  });

  it('derivePositionsCount counts open trades', () => {
    expect(derivePositionsCount(trades)).toBe(3);
  });

  it('handles empty / missing fields without crashing', () => {
    expect(deriveCapitalDeployed([])).toBe(0);
    expect(
      deriveCapitalDeployed([makeTrade({ entryPrice: undefined as unknown as number })]),
    ).toBe(0);
  });
});

describe('tradesToPositions', () => {
  it('maps a trade to a Position with entryPrice-based fallback when no ltp', () => {
    const [p] = tradesToPositions([
      makeTrade({ symbol: 'INFY', entryPrice: 200, quantity: 5, ltp: undefined as unknown as number, pnl: undefined as unknown as number }),
    ]);
    expect(p.symbol).toBe('INFY');
    expect(p.averagePrice).toBe(200);
    expect(p.ltp).toBe(200); // falls back to entryPrice
    expect(p.pnl).toBe(0);
  });

  it('computes P&L from ltp for a BUY', () => {
    const [p] = tradesToPositions([
      makeTrade({ side: 'BUY', entryPrice: 100, quantity: 10, ltp: 110, pnl: undefined as unknown as number, pnlPercent: undefined as unknown as number }),
    ]);
    expect(p.pnl).toBe(100); // (110-100)*10
    expect(p.pnlPercent).toBeCloseTo(10);
  });
});

describe('overlayLivePrices', () => {
  // Base position as the manual-trade page sees it before any live price:
  // an open trade with no ltp prices flat at entry → P&L 0 (the reported bug).
  const base = tradesToPositions([
    makeTrade({
      symbol: 'RELIANCE',
      side: 'BUY',
      entryPrice: 100,
      quantity: 10,
      ltp: undefined as unknown as number,
      pnl: undefined as unknown as number,
      pnlPercent: undefined as unknown as number,
    }),
  ]);

  it('drives P&L from a fetched quote when no live tick exists (the bug fix)', () => {
    // Open Positions previously only had live WS ticks, which never arrive for
    // unsubscribed held symbols → P&L stuck at 0. A fetched per-token quote
    // seeded into the same symbol→price map must now mark the position.
    const [p] = overlayLivePrices(base, { RELIANCE: 110 });
    expect(p.ltp).toBe(110);
    expect(p.pnl).toBe(100); // (110-100)*10
    expect(p.pnlPercent).toBeCloseTo(10);
  });

  it('leaves a position unchanged when its symbol has no price', () => {
    const [p] = overlayLivePrices(base, { TCS: 4000 });
    expect(p.ltp).toBe(100); // still entry
    expect(p.pnl).toBe(0);
  });

  it('respects SELL direction (price up = loss)', () => {
    const sellBase = tradesToPositions([
      makeTrade({
        symbol: 'INFY',
        side: 'SELL',
        entryPrice: 200,
        quantity: 5,
        ltp: undefined as unknown as number,
        pnl: undefined as unknown as number,
        pnlPercent: undefined as unknown as number,
      }),
    ]);
    const [p] = overlayLivePrices(sellBase, { INFY: 210 });
    expect(p.pnl).toBe(-50); // (210-200)*5*-1
  });
});
