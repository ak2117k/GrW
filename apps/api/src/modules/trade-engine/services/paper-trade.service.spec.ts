import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradeService } from './paper-trade.service';
import { TradeRepository } from '../repositories/trade.repository';
import {
  MarketFeedService,
  BROKER_ADAPTER_TOKEN,
} from '../../market-data/services/market-feed.service';
import { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';

/** Stub repo for the service constructor — onModuleInit isn't called in these tests. */
const mockTradeRepository = {
  findPaperTradesSince: jest.fn().mockResolvedValue([]),
  getOpenTrades: jest.fn().mockResolvedValue([]),
};

/** Stub market feed — quote cache is empty unless a test overrides getQuote. */
const mockMarketFeed = {
  getQuote: jest.fn(() => null),
};

/**
 * Regression spec for the "paper trade entryPrice = 0/null" bug.
 *
 * Before the fix, simulateOrder() returned only { orderId, status, message }
 * — the slippage-adjusted fillPrice computed inside fillAtPrice() was
 * thrown away. TradeExecutionService then fell back to request.price ??
 * request.triggerPrice, both undefined for MARKET orders, so entryPrice
 * persisted as null and corrupted P&L (multiplier * (ltp - 0) * qty).
 *
 * The fix surfaces fillPrice on the OrderResponse so the caller can
 * record the actual fill on the trade row.
 */
describe('PaperTradeService.simulateOrder — fillPrice exposure', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
  });

  it('MARKET order falls back to request.price when no LTP is cached, exposing it as fillPrice (+ slippage)', async () => {
    const request: OrderRequest = {
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 50,
      price: 125.5, // simulator uses this as base when LTP cache is empty
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('FILLED');
    expect(response.fillPrice).toBeDefined();
    expect(response.fillPrice).toBeGreaterThan(0);
    // BUY slippage skews UP — fill should be at or above base price
    expect(response.fillPrice).toBeGreaterThanOrEqual(125.5);
    // …but not insanely far above (slippage cap is 0.05%)
    expect(response.fillPrice).toBeLessThanOrEqual(125.5 * 1.001);
  });

  it('MARKET SELL order applies negative slippage (fillPrice <= base)', async () => {
    const request: OrderRequest = {
      symbol: 'BANKNIFTY24MAY45000PE',
      token: '99926001',
      exchange: 'NFO',
      side: 'SELL',
      orderType: 'MARKET',
      quantity: 25,
      price: 200,
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('FILLED');
    expect(response.fillPrice).toBeDefined();
    // SELL slippage skews DOWN
    expect(response.fillPrice).toBeLessThanOrEqual(200);
    expect(response.fillPrice).toBeGreaterThan(200 * 0.999);
  });

  it('LIMIT order with no LTP returns PENDING with no fillPrice', async () => {
    const request: OrderRequest = {
      symbol: 'NIFTY24MAY22500CE',
      token: '99926000',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 50,
      price: 100,
      positionType: 'INTRADAY',
    };

    const response = await service.simulateOrder(request);

    expect(response.status).toBe('PENDING');
    expect(response.fillPrice).toBeUndefined();
  });

  it('a MARKET order fills off the LTP cached by simulateTick (consistent cache key)', async () => {
    // simulateTick caches the LTP; a later MARKET order on the SAME token must
    // fill off that cached LTP, not fall back to request.price. The write key
    // and the read key must match.
    service.simulateTick({ token: '11536', symbol: 'TCS-EQ', ltp: 500 } as never);

    const response = await service.simulateOrder({
      symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 10, price: 999, positionType: 'INTRADAY',
    });

    expect(response.status).toBe('FILLED');
    // Filled off the cached LTP 500 (± slippage) — NOT request.price 999.
    expect(response.fillPrice).toBeGreaterThanOrEqual(500);
    expect(response.fillPrice).toBeLessThanOrEqual(500 * 1.001);
  });
});

describe('PaperTradeService.simulateOrder — MARKET broker-quote fallback', () => {
  let service: PaperTradeService;
  let broker: { getLiveQuote: jest.Mock };

  beforeEach(async () => {
    broker = { getLiveQuote: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
        { provide: BROKER_ADAPTER_TOKEN, useValue: broker },
      ],
    }).compile();
    service = module.get(PaperTradeService);
  });

  it('a MARKET order on a symbol NOT on the feed fills off a fresh broker quote (no ₹0 fill)', async () => {
    // No simulateTick → ltpCache empty; MARKET order carries no request.price.
    // The broker quote fallback supplies the fill price (the bug: it filled ₹0).
    broker.getLiveQuote.mockResolvedValue({ ltp: 250 });

    const response = await service.simulateOrder({
      symbol: 'SBIN-EQ', token: '3045', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 10, positionType: 'INTRADAY',
    });

    expect(broker.getLiveQuote).toHaveBeenCalledWith('3045', 'NSE');
    expect(response.status).toBe('FILLED');
    expect(response.fillPrice).toBeGreaterThanOrEqual(250); // BUY slippage skews up
    expect(response.fillPrice).toBeLessThanOrEqual(250 * 1.001);
  });

  it('still fills at ₹0 (caller rejects) when the broker quote is also unavailable', async () => {
    broker.getLiveQuote.mockResolvedValue({ ltp: 0 });
    const response = await service.simulateOrder({
      symbol: 'ZZFAKE-EQ', token: '000', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 1, positionType: 'INTRADAY',
    });
    // fillPrice 0 → TradeExecutionService rejects with the no-₹0-fill 400 (its job).
    expect(response.fillPrice).toBe(0);
  });
});

/**
 * Position netting — partial-exit and trailing-stop SELL fills should reduce
 * the existing BUY position rather than spawning a new opposite-side slot.
 * Verifies the fix to Gap 1+3 from the watch-monitor partial-exit flow.
 */
describe('PaperTradeService.simulateOrder — position netting', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000); // ₹20L fresh slate
  });

  const buildBuy = (qty: number, price: number): OrderRequest => ({
    symbol: 'TCS-EQ',
    token: '11536',
    exchange: 'NSE',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: qty,
    price,
    positionType: 'INTRADAY',
  });

  const buildSell = (qty: number, price: number): OrderRequest => ({
    ...buildBuy(qty, price),
    side: 'SELL',
  });

  it('defaults a fresh portfolio to the ₹40L paper float (raised from ₹20L for shared-track headroom)', () => {
    // The paper cash gate (RiskManager.checkPaperCashSufficient) checks this
    // float, and all 5 paper tracks share it. ₹20L was exhausted intraday by
    // ~16 concurrent positions (₹17-18L deployed), declining later alerts that
    // then sat stuck in WATCHING. Raised to ₹40L to roughly double the
    // fundable concurrency.
    service.resetVirtualPortfolio(); // no arg → DEFAULT_VIRTUAL_CAPITAL
    expect(service.getVirtualBalance()).toBe(4_000_000);
  });

  it('partial-exit SELL reduces the existing BUY qty instead of creating a new SELL slot', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(1000, 101));

    const positions = service.getVirtualPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('BUY');
    expect(positions[0].quantity).toBe(1000);
    // averagePrice on the remaining long is the original cost basis (100),
    // not re-averaged by the partial close.
    expect(positions[0].averagePrice).toBeCloseTo(100, 1);
  });

  it('full-close SELL nets the position to zero (deleted from map)', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(1000, 101));
    await service.simulateOrder(buildSell(1000, 100.5));

    expect(service.getVirtualPositions()).toHaveLength(0);
  });

  it('over-close flips the position to the opposite side at the new fill price', async () => {
    await service.simulateOrder(buildBuy(2000, 100));
    await service.simulateOrder(buildSell(3000, 102));

    const positions = service.getVirtualPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe('SELL');
    expect(positions[0].quantity).toBe(1000);
    expect(positions[0].averagePrice).toBeCloseTo(102, 1);
  });

  it('account equity tracks correctly through the full partial-exit + trailing-stop flow', async () => {
    // BUY 2000 @ 100 → cash -200,000, deployed 200,000
    await service.simulateOrder(buildBuy(2000, 100));
    // Partial exit at +1%: SELL 1000 @ 101 → cash +101,000 (realized +1,000)
    await service.simulateOrder(buildSell(1000, 101));
    // Trailing stop fires: SELL 1000 @ 100.5 → cash +100,500 (realized +500)
    await service.simulateOrder(buildSell(1000, 100.5));

    const acc = await service.getAccount();
    // Cash math (ignoring slippage): 2,000,000 - 200,000 + 101,000 + 100,500
    //   = 2,001,500. Slippage adds ±0.05% per fill — total worst case ~₹300.
    // The trade is profitable (closed +₹1,500 minus slippage costs), so we
    // bracket the result: noticeably above start, well under +₹2k.
    expect(acc.balance).toBeGreaterThan(2_000_500);
    expect(acc.balance).toBeLessThan(2_002_000);
    // Position fully closed → deployed=0, openPositions=0 (no open trades in DB)
    expect(acc.deployedCapital).toBe(0);
    expect(acc.openPositions).toBe(0);
    // Equity matches cash since no open positions remain.
    expect(acc.equity).toBe(acc.balance);
  });
});

/**
 * Restart recovery — onModuleInit must rebuild BOTH the cash balance AND
 * the in-memory virtual positions from the persisted trades, so the
 * account view (deployedCapital / openPositions) survives a restart.
 */
describe('PaperTradeService.onModuleInit — balance + position rehydration', () => {
  async function buildWith(trades: any[]): Promise<PaperTradeService> {
    const repo = { findPaperTradesSince: jest.fn().mockResolvedValue(trades) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get(PaperTradeService);
    await service.onModuleInit();
    return service;
  }

  it('rehydrates virtual positions from open trades so deployedCapital is restored', async () => {
    const openTrades = [
      {
        status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000, pnl: null,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ];
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue([
        ...openTrades,
        {
          status: 'CLOSED', side: 'BUY', quantity: 5, entryPrice: 100, exitPrice: 200,
          pnl: 500, instrument: { symbol: 'INFY-EQ', exchange: 'NSE' },
        },
      ]),
      // getAccount() derives deployed/positions from the DB open trades.
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    await service.onModuleInit();

    const acc = await service.getAccount();
    expect(acc.openPositions).toBe(1);
    expect(acc.deployedCapital).toBe(10_000); // 10 * 1000
    // balance = 40L - 10,000 (open BUY cost) + 500 (closed pnl)
    expect(acc.balance).toBe(4_000_000 - 10_000 + 500);
  });

  it('rehydrates a PARTIALLY_FILLED trade as an open position of the remaining qty', async () => {
    const openTrades = [
      {
        status: 'PARTIALLY_FILLED', side: 'BUY', quantity: 6, entryPrice: 1000, pnl: 120,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ];
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue(openTrades),
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    await service.onModuleInit();

    const acc = await service.getAccount();
    expect(acc.openPositions).toBe(1);
    expect(acc.deployedCapital).toBe(6_000); // 6 remaining * 1000
    // balance = 40L - 6,000 (remaining cost) + 120 (realized partial pnl)
    expect(acc.balance).toBe(4_000_000 - 6_000 + 120);
  });

  it('subtracts an OPEN trade recorded entry-charge fees from the replayed balance', async () => {
    const openTrades = [
      {
        status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000, pnl: null, fees: 37,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ];
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue(openTrades),
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    await service.onModuleInit();

    // balance = 40L - 10,000 (open BUY cost) - 37 (recorded entry charge)
    expect(service.getVirtualBalance()).toBe(4_000_000 - 10_000 - 37);
  });

  it('a closed trade nets pnl MINUS its recorded broker fees', async () => {
    // fees accumulates real SEBI charges per close event; a trade partially
    // then fully closed carries two charges' worth. The replay must subtract
    // it so the recovered balance matches what applyExitAccounting did live.
    const service = await buildWith([
      {
        status: 'CLOSED', side: 'BUY', quantity: 10, entryPrice: 100,
        exitPrice: 150, pnl: 500, fees: 200,
        instrument: { symbol: 'INFY-EQ', exchange: 'NSE' },
      },
    ]);

    // balance = 40L + 500 (pnl) - 200 (fees)
    expect(service.getVirtualBalance()).toBe(4_000_000 + 500 - 200);
  });
});

describe('PaperTradeService - entry & exit charges (R6)', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
  });

  it('applyEntryCharge debits the supplied charge from the virtual balance', () => {
    service.applyEntryCharge(57.34);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 57.34, 2);
  });

  it('a losing exit deducts the supplied exit charge and defers nothing', async () => {
    const charge = service.applyExitAccounting(-5000, 42.5);
    expect(charge).toBe(42.5);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 42.5, 2);
    expect((await service.getAccount()).pendingProfit).toBe(0);
  });

  it('a winning exit withholds the profit and deducts the exit charge', async () => {
    const charge = service.applyExitAccounting(8000, 55);
    expect(charge).toBe(55);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 8000 - 55, 2);
    expect((await service.getAccount()).pendingProfit).toBe(8000);
  });
});

describe('PaperTradeService.settlePendingProfit — 18:00 IST after-hours settlement', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
  });

  it('sweeps accumulated deferred profit into the spendable cash balance', async () => {
    service.applyExitAccounting(8000, 100); // balance 1,991,900 · pending 8,000
    service.settlePendingProfit();
    expect(service.getVirtualBalance()).toBe(2_000_000 - 100); // profit credited back
    expect((await service.getAccount()).pendingProfit).toBe(0);
  });

  it('is a no-op when there is no pending profit', () => {
    service.applyExitAccounting(-3000, 100); // pure loss — nothing deferred
    const balBefore = service.getVirtualBalance();
    service.settlePendingProfit();
    expect(service.getVirtualBalance()).toBe(balBefore);
  });

  it('equity is unchanged by settlement — it only moves pending → cash', async () => {
    service.applyExitAccounting(8000, 100);
    const equityBefore = (await service.getAccount()).equity;
    service.settlePendingProfit();
    expect((await service.getAccount()).equity).toBe(equityBefore);
  });
});

/**
 * Live equity refresher — keeps open positions' unrealized P&L fresh by
 * polling the market-feed quote cache, independent of the tick stream.
 */
describe('PaperTradeService.refreshOpenPositions — live equity refresher', () => {
  async function buildWithFeed(
    feed: { getQuote: jest.Mock },
    openTrades: any[] = [],
  ): Promise<PaperTradeService> {
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue([]),
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
    return service;
  }

  const buyOrder: OrderRequest = {
    symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
    orderType: 'MARKET', quantity: 2000, price: 100, positionType: 'INTRADAY',
  };

  it('updates each open position ltp/pnl from the market-feed quote cache', async () => {
    const feed = { getQuote: jest.fn(() => ({ ltp: 110 })) };
    // The position is also open in the DB, so its live pnl counts toward equity.
    const service = await buildWithFeed(feed, [
      {
        status: 'OPEN', side: 'BUY', quantity: 2000, entryPrice: 100,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ]);
    await service.simulateOrder(buyOrder);

    service.refreshOpenPositions();

    const pos = service.getVirtualPositions()[0];
    expect(feed.getQuote).toHaveBeenCalledWith('11536');
    expect(pos.ltp).toBe(110);
    // pnl = (110 - ~100) * 2000 ≈ 20,000 (entry slippage only)
    expect(pos.pnl).toBeGreaterThan(19_000);
    expect((await service.getAccount()).unrealizedPnl).toBeGreaterThan(19_000);
  });

  it('skips a position whose token has no cached quote, keeping its last value', async () => {
    const feed = { getQuote: jest.fn(() => null) };
    const service = await buildWithFeed(feed);
    await service.simulateOrder(buyOrder);

    expect(() => service.refreshOpenPositions()).not.toThrow();
    expect(service.getVirtualPositions()[0].pnl).toBe(0);
  });
});

/**
 * Stale-state regression: getAccount() must derive deployedCapital and
 * openPositions from the `Trade` table's open trades — the SAME source the
 * risk manager uses — so the UI badge and the risk engine can never drift.
 *
 * Before the fix, getAccount() summed the in-memory `virtualPositions` map,
 * which was hydrated once at startup and not always cleaned when a position
 * closed mid-session via a path other than a netting SELL fill (e.g. the
 * position manager closing the DB trade directly). Closed positions lingered
 * as ghosts, overstating deployedCapital and equity.
 */
describe('PaperTradeService.getAccount — Trade table is the single source of truth', () => {
  async function buildWith(
    openTrades: any[],
    feedQuote: ((token: string) => any) | null = null,
  ): Promise<PaperTradeService> {
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue([]),
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const feed = { getQuote: jest.fn(feedQuote ?? (() => null)) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: feed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
    return service;
  }

  it('deployedCapital and openPositions equal the summed entry value / count of DB open trades', async () => {
    const service = await buildWith([
      { status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000 }, // ₹10,000
      { status: 'PARTIALLY_FILLED', side: 'SELL', quantity: 4, entryPrice: 250.5 }, // ₹1,002
    ]);

    const acc = await service.getAccount();

    // Mirrors RiskManagerService.getDailyRiskStatus(): Σ entryPrice × qty.
    expect(acc.deployedCapital).toBe(1000 * 10 + 250.5 * 4);
    expect(acc.openPositions).toBe(2);
  });

  it('a position closed mid-session is NOT counted in deployedCapital / openPositions', async () => {
    // Position opened — lives in the in-memory map AND in the DB open trades.
    const service = await buildWith([
      { status: 'OPEN', side: 'BUY', quantity: 2000, entryPrice: 100 },
    ]);
    await service.simulateOrder({
      symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 2000, price: 100, positionType: 'INTRADAY',
    });

    const before = await service.getAccount();
    expect(before.openPositions).toBe(1);
    expect(before.deployedCapital).toBe(2000 * 100);

    // The trade closes in the DB (status flips to CLOSED) but the in-memory
    // virtualPositions map is NOT cleaned — a ghost lingers. getAccount()
    // must still report deployed=0 because it reads the DB, not the map.
    (service as any).tradeRepository.getOpenTrades.mockResolvedValue([]);

    const after = await service.getAccount();
    expect(after.openPositions).toBe(0);
    expect(after.deployedCapital).toBe(0);
    // …even though the ghost is still present in the in-memory map.
    expect(service.getVirtualPositions().length).toBeGreaterThan(0);
  });

  it('unrealizedPnl counts only positions that are still open in the DB (ignores ghosts)', async () => {
    // Two positions opened in the map; only TCS remains open in the DB.
    const service = await buildWith(
      [{ status: 'OPEN', side: 'BUY', quantity: 2000, entryPrice: 100,
         instrument: { symbol: 'TCS-EQ', exchange: 'NSE' } }],
      (token: string) => (token === '11536' ? { ltp: 110 } : { ltp: 500 }),
    );
    await service.simulateOrder({
      symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 2000, price: 100, positionType: 'INTRADAY',
    });
    await service.simulateOrder({
      symbol: 'INFY-EQ', token: '99999', exchange: 'NSE', side: 'BUY',
      orderType: 'MARKET', quantity: 1000, price: 400, positionType: 'INTRADAY',
    });
    service.refreshOpenPositions();

    const acc = await service.getAccount();
    // Only TCS's live pnl (~+20,000) counts; the INFY ghost (+100,000) does not.
    expect(acc.unrealizedPnl).toBeGreaterThan(19_000);
    expect(acc.unrealizedPnl).toBeLessThan(25_000);
    expect(acc.openPositions).toBe(1);
  });
});

/**
 * Startup-replay regression: a closed trade must NOT be re-hydrated as an
 * open position regardless of its exact terminal status. The replay must
 * treat only OPEN / PARTIALLY_FILLED as open — every other status
 * (CLOSED, CANCELLED, REJECTED, EXPIRED, …) is a non-open trade.
 */
describe('PaperTradeService.onModuleInit — terminal-status replay safety', () => {
  async function replayWith(trades: any[]): Promise<PaperTradeService> {
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue(trades),
      getOpenTrades: jest.fn().mockResolvedValue(
        trades.filter((t) => t.status === 'OPEN' || t.status === 'PARTIALLY_FILLED'),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    await service.onModuleInit();
    return service;
  }

  it('does not rehydrate a CANCELLED trade as an open position', async () => {
    const service = await replayWith([
      {
        status: 'CANCELLED', side: 'BUY', quantity: 10, entryPrice: 1000,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ]);
    // A cancelled order never deployed capital — it must not appear as open.
    expect(service.getVirtualPositions()).toHaveLength(0);
    const acc = await service.getAccount();
    expect(acc.openPositions).toBe(0);
    expect(acc.deployedCapital).toBe(0);
  });

  it('does not rehydrate a REJECTED trade as an open position', async () => {
    const service = await replayWith([
      {
        status: 'REJECTED', side: 'BUY', quantity: 5, entryPrice: 800,
        instrument: { symbol: 'INFY-EQ', exchange: 'NSE' },
      },
    ]);
    expect(service.getVirtualPositions()).toHaveLength(0);
    expect((await service.getAccount()).openPositions).toBe(0);
  });

  it('still rehydrates genuine OPEN trades alongside non-open terminal ones', async () => {
    const service = await replayWith([
      {
        status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
      {
        status: 'EXPIRED', side: 'BUY', quantity: 7, entryPrice: 500,
        instrument: { symbol: 'WIPRO-EQ', exchange: 'NSE' },
      },
    ]);
    // Only the OPEN trade is a live position.
    expect(service.getVirtualPositions()).toHaveLength(1);
    expect(service.getVirtualPositions()[0].symbol).toBe('TCS-EQ');
  });
});

/**
 * REST fallback — when a position's token is not on Angel One's WebSocket
 * (the socket caps at ~50 tokens, so open-position tokens get squeezed out
 * by indices + the scanner), refreshOpenPositions must fetch a fresh quote
 * over REST so the position marks to market instead of freezing at entry.
 */
describe('PaperTradeService.refreshOpenPositions — REST fallback when WS cache misses', () => {
  async function buildWithBroker(
    feed: { getQuote: jest.Mock },
    broker: { getLiveQuote: jest.Mock },
  ): Promise<PaperTradeService> {
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue([]),
      getOpenTrades: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: feed },
        { provide: BROKER_ADAPTER_TOKEN, useValue: broker },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
    return service;
  }

  const buyOrder: OrderRequest = {
    symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', side: 'BUY',
    orderType: 'MARKET', quantity: 2000, price: 100, positionType: 'INTRADAY',
  };

  it('falls back to a REST broker quote when the WS quote cache has no tick', async () => {
    const feed = { getQuote: jest.fn(() => null) }; // token not on the WebSocket
    const broker = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 110 }) };
    const service = await buildWithBroker(feed, broker);
    await service.simulateOrder(buyOrder);

    await service.refreshOpenPositions();

    const pos = service.getVirtualPositions()[0];
    expect(broker.getLiveQuote).toHaveBeenCalledWith('11536', 'NSE');
    expect(pos.ltp).toBe(110);
    expect(pos.pnl).toBeGreaterThan(19_000); // (110 - ~100) * 2000
  });

  it('does not call the broker when the WS cache already has a tick', async () => {
    const feed = { getQuote: jest.fn(() => ({ ltp: 105 })) };
    const broker = { getLiveQuote: jest.fn() };
    const service = await buildWithBroker(feed, broker);
    await service.simulateOrder(buyOrder);

    await service.refreshOpenPositions();

    expect(broker.getLiveQuote).not.toHaveBeenCalled();
    expect(service.getVirtualPositions()[0].ltp).toBe(105);
  });
});
