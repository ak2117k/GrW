import { Test } from '@nestjs/testing';
import {
  SellFuturesService,
  SellFuturesNoFutureError,
  SellFuturesSymbolDupError,
  SellFuturesCooldownError,
  SellFuturesNoQuoteError,
} from './sell-futures.service';
import { SellFuturesWatchRepository } from '../repositories/sell-futures-watch.repository';
import { SellFuturesTradeRepository } from '../repositories/sell-futures-trade.repository';
import {
  SellFuturesPaperAccountService,
  SellFuturesPositionCapError,
  SellFuturesMarginExhaustedError,
} from './sell-futures-paper-account.service';
import { FutureSelectorService } from './future-selector.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { PROFIT_TARGET_PCT, HARD_STOP_PCT } from '../constants';

const RESOLVED_FUTURE = {
  token: '62802',
  tradingsymbol: 'RELIANCE30JUN26FUT',
  exchange: 'NFO' as const,
  expiry: new Date('2026-07-28'),
  lotSize: 500,
};

const baseInput = {
  alertId: 'a1',
  setupId: null,
  symbol: 'RELIANCE',
  token: '2885',          // equity token
  exchange: 'NSE',
  side: 'SELL' as const,
  initialPrice: 1210,     // equity Chartink hit price
  initialScore: 55,
  initialBreakdown: { checks: [] },
  scannerName: 'some scanner',
};

describe('SellFuturesService.createFromAlert', () => {
  let svc: SellFuturesService;
  let repo: any, trades: any, account: any, selector: any, adapter: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
      countOpenTrades: jest.fn().mockResolvedValue(0),
      createEntry: jest.fn().mockResolvedValue({ id: 'sf1', token: '62802' }),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findById: jest.fn().mockResolvedValue({ id: 'sf1', token: '62802' }),
    };
    trades = {
      createTrade: jest.fn().mockResolvedValue({ id: 'sft1', entryPrice: 1200, quantity: 500 }),
    };
    account = {
      admit: jest.fn().mockResolvedValue(undefined),
      ensureMargin: jest.fn().mockResolvedValue(undefined),
      applyEntry: jest.fn().mockResolvedValue(undefined),
    };
    selector = { resolve: jest.fn().mockResolvedValue(RESOLVED_FUTURE) };
    // Live FUTURES quote (NFO) — distinct from the equity Chartink price.
    adapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 1200 }) };

    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesService,
        { provide: SellFuturesWatchRepository, useValue: repo },
        { provide: SellFuturesTradeRepository, useValue: trades },
        { provide: SellFuturesPaperAccountService, useValue: account },
        { provide: FutureSelectorService, useValue: selector },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(SellFuturesService);
  });

  it('gate 1: no future → SellFuturesNoFutureError, no entry, no trade', async () => {
    selector.resolve.mockResolvedValue(null);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesNoFutureError);
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(trades.createTrade).not.toHaveBeenCalled();
  });

  it('happy path: opens a paper SHORT on the FUTURES token at the futures price, qty = lotSize', async () => {
    const entry = await svc.createFromAlert(baseInput);
    expect(entry).toBeDefined();

    // The future is resolved from the EQUITY symbol.
    expect(selector.resolve).toHaveBeenCalledWith('RELIANCE');

    // Quote is taken on the FUTURES NFO token, not the equity.
    expect(adapter.getLiveQuote).toHaveBeenCalledWith('62802', 'NFO');

    // Trade is a SELL of one lot at the live futures price.
    expect(trades.createTrade).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL', quantity: 500, entryPrice: 1200 }),
    );
    expect(account.applyEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryPrice: 1200, quantity: 500 }),
    );

    // Entry row stores the futures contract + a SHORT 2% target off the fill.
    const createArg = repo.createEntry.mock.calls[0][0];
    expect(createArg.token).toBe('62802');
    expect(createArg.exchange).toBe('NFO');
    expect(createArg.eqToken).toBe('2885');
    expect(createArg.futTradingsymbol).toBe('RELIANCE30JUN26FUT');
    expect(createArg.lotSize).toBe(500);
    expect(createArg.profitTarget).toBeCloseTo(1200 * (1 - PROFIT_TARGET_PCT), 4);

    // Marked TRADED with the paper trade id.
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      status: 'TRADED', paperTradeId: 'sft1', executedPrice: 1200, quantity: 500,
    }));
  });

  it('gate 2: dedup on the FUTURES token → SellFuturesSymbolDupError', async () => {
    repo.findActiveByToken.mockResolvedValue([{ id: 'prev', token: '62802' }]);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesSymbolDupError);
    expect(repo.findActiveByToken).toHaveBeenCalledWith('62802');
    expect(trades.createTrade).not.toHaveBeenCalled();
  });

  it('gate 3: cooldown on the FUTURES token → SellFuturesCooldownError', async () => {
    repo.wasTokenExecutedSince.mockResolvedValue(true);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesCooldownError);
    expect(trades.createTrade).not.toHaveBeenCalled();
  });

  it('gate 4: position cap propagates from account.admit', async () => {
    account.admit.mockRejectedValue(new SellFuturesPositionCapError(25));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesPositionCapError);
  });

  it('gate 4: margin-exhausted propagates from account.ensureMargin', async () => {
    account.ensureMargin.mockRejectedValue(new SellFuturesMarginExhaustedError(1000, 120000));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesMarginExhaustedError);
    expect(trades.createTrade).not.toHaveBeenCalled();
  });

  it('gate 5: no live futures quote → SellFuturesNoQuoteError, no trade', async () => {
    adapter.getLiveQuote.mockResolvedValue({ ltp: 0 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesNoQuoteError);
    expect(trades.createTrade).not.toHaveBeenCalled();
  });

  it('gate 5: live quote throwing → SellFuturesNoQuoteError', async () => {
    adapter.getLiveQuote.mockRejectedValue(new Error('broker timeout'));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(SellFuturesNoQuoteError);
  });
});

describe('SellFuturesService.onTick — SHORT exits', () => {
  let svc: SellFuturesService;
  let repo: any, trades: any, account: any, selector: any, adapter: any;

  function tradedShort(overrides: Record<string, any> = {}) {
    return {
      id: 'sf1', token: '62802', symbol: 'RELIANCE', side: 'SELL', status: 'TRADED',
      exchange: 'NFO', initialPrice: 1200, executedPrice: 1200,
      profitTarget: 1200 * (1 - PROFIT_TARGET_PCT), // 1176
      paperTradeId: 'sft1', quantity: 500, remainingQty: 500,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      slBreachCount: 1, // already one strike so SL tests exit on this tick
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById: jest.fn(),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    trades = {};
    account = {};
    selector = {};
    adapter = {};
    const closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesService,
        { provide: SellFuturesWatchRepository, useValue: repo },
        { provide: SellFuturesTradeRepository, useValue: { getTradeById: jest.fn(), update: jest.fn() } },
        { provide: SellFuturesPaperAccountService, useValue: { applyExit: jest.fn() } },
        { provide: FutureSelectorService, useValue: selector },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(SellFuturesService);
    // Spy on the internal closeTrade so exit assertions don't need the trade repo.
    (svc as any).closeTrade = closeTrade;
    (svc as any).__closeTrade = closeTrade;
  });

  it('SHORT target: ltp <= profitTarget → target-hit', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedShort()]);
    await svc.onTick('62802', 1170, new Date()); // below 1176 target
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'target-hit', exitPrice: 1170,
    }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({ status: 'TARGET_HIT' }));
  });

  it('SHORT hard SL: ltp >= entry × (1 + HARD_STOP_PCT) → loss-cut', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedShort()]);
    const slPrice = 1200 * (1 + HARD_STOP_PCT); // 1204.8
    await svc.onTick('62802', slPrice + 2, new Date());
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'sl-loss-cut',
    }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('SHORT SL caps the exit at the SL price when a 30s poll overshoots above it', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedShort()]);
    const slPrice = 1200 * (1 + HARD_STOP_PCT); // 1204.8
    await svc.onTick('62802', 1230, new Date()); // overshoot well above SL
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: slPrice,
    }));
  });

  it('two-strike: first SL breach does NOT exit, only increments the counter', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedShort({ slBreachCount: 0 })]);
    await svc.onTick('62802', 1210, new Date()); // above SL threshold
    expect((svc as any).__closeTrade).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({ slBreachCount: 1 }));
  });

  // ── Partial-exit (SHORT: a FALLING price is favorable) ────────────────────

  it('partial-exit SHORT: price falls past +1% favorable → books a half-lot cover at the right side', async () => {
    // entry 1200, ltp 1182 → favorable move = (1200−1182)/1200 = 1.5% ≥ 1%.
    // 1182 is ABOVE the 1176 target (target does not fire first) and BELOW
    // entry (a profit, not an SL). Proves falling = favorable for a short.
    repo.findActiveByToken.mockResolvedValue([tradedShort()]);
    await svc.onTick('62802', 1182, new Date());
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'partial-exit', quantity: 250, exitPrice: 1182, // half of the 500-lot
    }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      partialExitedAt: expect.any(Date),
      partialExitPrice: 1182,
      partialQty: 250,
      remainingQty: 250,
      trailingHighWater: 1182,
      trailingStopPrice: 1182 * 1.005, // SHORT trail sits ABOVE the low-water mark
    }));
  });

  it('partial-exit SHORT: does NOT book a partial while price RISES against the short', async () => {
    // ltp 1203 is adverse for a short (above entry) but below the −0.4% SL
    // trigger (1204.8) → no partial, no exit.
    repo.findActiveByToken.mockResolvedValue([tradedShort({ slBreachCount: 0 })]);
    await svc.onTick('62802', 1203, new Date());
    expect((svc as any).__closeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalledWith('sf1', expect.objectContaining({
      partialExitedAt: expect.any(Date),
    }));
  });

  // ── Trailing-stop (SHORT: fires on a RISE back to the stop, not on the fall) ─

  function trailingShort(overrides: Record<string, any> = {}) {
    return tradedShort({
      profitTarget: 1, // never hit — isolate the trailing path
      partialExitedAt: new Date(),
      partialExitPrice: 1182,
      partialQty: 250,
      remainingQty: 250,
      trailingHighWater: 1185, // low-water mark for a short
      trailingStopPrice: 1185 * 1.005,
      ...overrides,
    });
  }

  it('trailing-stop SHORT: does NOT fire while price keeps FALLING (advances the low-water mark)', async () => {
    repo.findActiveByToken.mockResolvedValue([trailingShort()]);
    // ltp 1180 < low-water 1185 → favorable; advance the mark, new stop = 1180×1.005.
    await svc.onTick('62802', 1180, new Date());
    expect((svc as any).__closeTrade).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      trailingHighWater: 1180,
      trailingStopPrice: 1180 * 1.005,
    }));
    // Critically — NO exit on the favorable fall.
    expect(repo.update).not.toHaveBeenCalledWith('sf1', expect.objectContaining({
      status: 'EXITED',
    }));
  });

  it('trailing-stop SHORT: fires on a RISE back to the stop (ltp >= trailing stop)', async () => {
    // Low-water already at 1180 → stop = 1180×1.005 = 1185.9. Price rises to 1186.
    repo.findActiveByToken.mockResolvedValue([
      trailingShort({ trailingHighWater: 1180, trailingStopPrice: 1180 * 1.005 }),
    ]);
    await svc.onTick('62802', 1186, new Date()); // 1186 >= 1185.9 → trailing exit
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'trailing-stop', exitPrice: 1186,
    }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      status: 'EXITED', closedReason: 'trailing-stop',
    }));
  });
});

describe('SellFuturesService.onTick — SHORT realized-P&L sign (end-to-end through closeTrade)', () => {
  let svc: SellFuturesService;
  let repo: any, trades: any, account: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    // Real closeTrade path: getTradeById → trades.update(pnl) → account.applyExit.
    trades = {
      getTradeById: jest.fn().mockResolvedValue({
        id: 'sft1', side: 'SELL', quantity: 500, entryPrice: 1200,
        pnl: null, fees: 0, status: 'OPEN', closedQuantity: 0,
      }),
      update: jest.fn().mockResolvedValue({}),
    };
    account = { applyExit: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesService,
        { provide: SellFuturesWatchRepository, useValue: repo },
        { provide: SellFuturesTradeRepository, useValue: trades },
        { provide: SellFuturesPaperAccountService, useValue: account },
        { provide: FutureSelectorService, useValue: {} },
        { provide: AngelOneAdapterService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(SellFuturesService);
    // NOTE: closeTrade is intentionally NOT stubbed — we exercise the real path.
  });

  it('a short closing BELOW entry books POSITIVE pnl via the service path', async () => {
    // entry 1200, exit (target-hit) at 1170 → short profit = (1200−1170)×500 = +15,000.
    repo.findActiveByToken.mockResolvedValue([{
      id: 'sf1', token: '62802', symbol: 'RELIANCE', side: 'SELL', status: 'TRADED',
      exchange: 'NFO', initialPrice: 1200, executedPrice: 1200,
      profitTarget: 1200 * (1 - PROFIT_TARGET_PCT), // 1176
      paperTradeId: 'sft1', quantity: 500, remainingQty: 500, slBreachCount: 1,
    }]);

    await svc.onTick('62802', 1170, new Date()); // <= 1176 → target-hit

    // The trade row's pnl must be POSITIVE (short won as price fell below entry).
    const update = trades.update.mock.calls.find((c: any[]) => c[0] === 'sft1');
    expect(update).toBeDefined();
    expect(update![1].pnl).toBeGreaterThan(0);
    expect(update![1].pnl).toBeCloseTo(15000, 0);

    // And the paper account books the same positive slice (sideMul = −1).
    expect(account.applyExit).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 1200, exitPrice: 1170, quantity: 500, sideMul: -1,
    }));
  });
});

describe('SellFuturesService.squareOffOpenPositions — EOD', () => {
  let svc: SellFuturesService;
  let repo: any, adapter: any;

  beforeEach(async () => {
    repo = {
      findAllActive: jest.fn().mockResolvedValue([
        { id: 'sf1', token: '62802', symbol: 'RELIANCE', exchange: 'NFO', status: 'TRADED',
          paperTradeId: 'sft1', executedPrice: 1200, currentPrice: 1190 },
      ]),
      update: jest.fn().mockResolvedValue({}),
      createEvent: jest.fn(),
    };
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map([['62802', 1185]])) };
    const closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesService,
        { provide: SellFuturesWatchRepository, useValue: repo },
        { provide: SellFuturesTradeRepository, useValue: { getTradeById: jest.fn(), update: jest.fn() } },
        { provide: SellFuturesPaperAccountService, useValue: { applyExit: jest.fn() } },
        { provide: FutureSelectorService, useValue: {} },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(SellFuturesService);
    (svc as any).closeTrade = closeTrade;
    (svc as any).__closeTrade = closeTrade;
  });

  it('closes every TRADED entry at the live futures LTP with reason eod-square-off', async () => {
    const res = await svc.squareOffOpenPositions();
    expect(res.closed).toBe(1);
    expect((svc as any).__closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({
      reason: 'eod-square-off', exitPrice: 1185,
    }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({
      status: 'EXITED', closedReason: 'eod-square-off',
    }));
  });
});
