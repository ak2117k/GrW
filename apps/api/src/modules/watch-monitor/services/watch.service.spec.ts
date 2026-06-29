import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WatchService, WatchCapExceededError, TradeCooldownError, TradeSellDirectionError, TradeLastLossError, TRADE_COOLDOWN_MS } from './watch.service';
import { WatchRepository } from '../repositories/watch.repository';
import { TargetCalculatorService } from './target-calculator.service';
import { StrikeSelectorService } from './strike-selector.service';
import { MarketFeedService, BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { LevelBookService } from '../../signal-generator/services/level-book.service';
import { WatchGateway } from '../gateways/watch.gateway';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { DEFAULT_MAX_CAPITAL_PER_TRADE } from '@td/shared';
import * as marketHours from '../../../common/utils/market-hours';

// Loosely typed: tests assign `executeTrade`/`closeTrade` dynamically per case.
const mockTrade: any = { closeTrade: jest.fn().mockResolvedValue({}) };

describe('WatchService.createFromAlert', () => {
  let svc: WatchService;
  let repo: any;
  let target: any;
  let strike: any;
  let feed: any;
  let levelBook: any;

  beforeEach(async () => {
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') }); // 10:00 IST
    // Default: run as if INSIDE the 09:15-15:00 IST entry window so the
    // auto-execute path is exercised. The executeEntry cutoff describe-block
    // overrides this with its own spy to test the after-15:00 path.
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = {
      findActiveBySetupId: jest.fn().mockResolvedValue(null),
      findActiveByToken: jest.fn().mockResolvedValue([]),
      countActive: jest.fn().mockResolvedValue(0),
      createEntry: jest.fn().mockResolvedValue({ id: 'w1', token: '11536' }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
      getLastClosedPnlForToken: jest.fn().mockResolvedValue(null),
      getLastClosedTradeForToken: jest.fn().mockResolvedValue(null),
      countRecoveryReentriesToday: jest.fn().mockResolvedValue(0),
    };
    target = { compute: jest.fn().mockReturnValue({ target: 4150, source: 'indicator-sr' }) };
    strike = { pick: jest.fn().mockResolvedValue(null) };
    feed = { subscribeForWatch: jest.fn() };
    // NOTE: LevelBookService uses getLevels(token) (sync), not getSnapshot.
    // The mock is named getLevels to match the real service API.
    levelBook = { getLevels: jest.fn().mockReturnValue(null) };

    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: target },
        { provide: StrikeSelectorService, useValue: strike },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: levelBook },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 4000 }) } },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const baseInput = {
    alertId: 'a1', setupId: 's1', symbol: 'TCS-EQ', token: '11536',
    exchange: 'NSE', side: 'BUY' as const, initialPrice: 4000,
    initialScore: 72, initialBreakdown: { foo: 1 },
  };

  it('throws WatchCapExceededError at 50 active entries', async () => {
    repo.countActive.mockResolvedValue(50);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(WatchCapExceededError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('emits a [trade-rejected] line when the watch cap is exceeded', async () => {
    repo.countActive.mockResolvedValue(50);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(
      WatchCapExceededError,
    );

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('TCS-EQ');
    expect(line).toContain('stage=watch');
    expect(line).toContain('side=BUY');
    expect(line).toMatch(/reason="Watch entry cap exceeded/);
    warn.mockRestore();
  });

  it('emits a [trade-rejected] line when auto-execute fails', async () => {
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockRejectedValue(
      new Error('Insufficient paper cash: need ₹20,00,000, available ₹0'),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await svc.createFromAlert(baseInput);

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.startsWith('[trade-rejected]'));
    expect(line).toBeDefined();
    expect(line).toContain('TCS-EQ');
    expect(line).toContain('stage=execution');
    expect(line).toContain('side=BUY');
    expect(line).toMatch(/reason="Auto-execute failed/);
    warn.mockRestore();
  });

  it('does not journal a bogus null-entryPrice failure when a gate declines the entry', async () => {
    // When a gate (upside / entry-window / no-quote) declines, executeEntry
    // records the REAL reason and returns null. createFromAlert must not then
    // dereference (null).entryPrice — the NRE was being caught and journaled as
    // a masking "auto-execute failed: Cannot read properties of null (reading
    // 'entryPrice')" NOT_TRADED event, hiding the true gate reason.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    jest.spyOn(svc, 'executeEntry').mockResolvedValue(null);

    await svc.createFromAlert(baseInput);

    const nreEvent = repo.createEvent.mock.calls.find(
      ([arg]: [any]) =>
        typeof arg?.notes === 'string' &&
        arg.notes.includes("Cannot read properties of null"),
    );
    expect(nreEvent).toBeUndefined();
  });

  it('returns existing entry on duplicate setupId (idempotent)', async () => {
    repo.findActiveBySetupId.mockResolvedValue({ id: 'existing', token: '11536' });
    const r = await svc.createFromAlert(baseInput);
    expect(r.id).toBe('existing');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('returns existing entry when same stock is already being watched (token dedup)', async () => {
    // Different Chartink setup (different setupId) but SAME stock token.
    // Should return the existing entry instead of creating a duplicate.
    repo.findActiveBySetupId.mockResolvedValue(null); // new setup
    repo.findActiveByToken.mockResolvedValue([
      { id: 'first-watch-of-tcs', token: '11536', status: 'WATCHING', symbol: 'TCS-EQ' },
    ]);
    const r = await svc.createFromAlert(baseInput);
    expect(r.id).toBe('first-watch-of-tcs');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  describe('smart loss-recovery re-entry gate', () => {
    const passingBreakdown = {
      checks: [
        { name: 'MACD on 5m', passed: true },
        { name: 'VWAP relationship', passed: true },
        { name: 'RSI on 5m', passed: true },
        { name: 'ADX trend strength', passed: true },
      ],
    };

    it('admits a same-day loss as a half-size recovery when score>80, momentum passes, price reclaimed', async () => {
      repo.getLastClosedTradeForToken.mockResolvedValue({ pnl: -500, entryPrice: 3900 });
      repo.countRecoveryReentriesToday.mockResolvedValue(0);
      await svc.createFromAlert({
        ...baseInput,
        initialScore: 85,
        initialBreakdown: passingBreakdown,
        initialPrice: 3950, // >= prior entry 3900 → reclaimed
      });
      expect(repo.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryReEntry: true }),
      );
    });

    it('blocks the loss re-entry when the recovery bar is not met (score not above 80)', async () => {
      repo.getLastClosedTradeForToken.mockResolvedValue({ pnl: -500, entryPrice: 3900 });
      repo.countRecoveryReentriesToday.mockResolvedValue(0);
      await expect(
        svc.createFromAlert({
          ...baseInput,
          initialScore: 78,
          initialBreakdown: passingBreakdown,
          initialPrice: 3950,
        }),
      ).rejects.toBeInstanceOf(TradeLastLossError);
      expect(repo.createEntry).not.toHaveBeenCalled();
    });

    it('blocks when price has not reclaimed the prior entry, even with a strong score', async () => {
      repo.getLastClosedTradeForToken.mockResolvedValue({ pnl: -500, entryPrice: 3900 });
      repo.countRecoveryReentriesToday.mockResolvedValue(0);
      await expect(
        svc.createFromAlert({
          ...baseInput,
          initialScore: 90,
          initialBreakdown: passingBreakdown,
          initialPrice: 3850, // below prior entry 3900 → not reclaimed
        }),
      ).rejects.toBeInstanceOf(TradeLastLossError);
    });

    it('blocks a second recovery the same day (cap = 1)', async () => {
      repo.getLastClosedTradeForToken.mockResolvedValue({ pnl: -500, entryPrice: 3900 });
      repo.countRecoveryReentriesToday.mockResolvedValue(1); // already recovered once
      await expect(
        svc.createFromAlert({
          ...baseInput,
          initialScore: 90,
          initialBreakdown: passingBreakdown,
          initialPrice: 3950,
        }),
      ).rejects.toBeInstanceOf(TradeLastLossError);
    });

    it('a green prior close re-enters normally with recoveryReEntry false', async () => {
      repo.getLastClosedTradeForToken.mockResolvedValue({ pnl: 1200, entryPrice: 3900 });
      await svc.createFromAlert(baseInput);
      expect(repo.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryReEntry: false }),
      );
    });
  });

  it('R1: does not create a second entry while one is active for the symbol', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([
      { id: 'already-open', token: '11536', status: 'TRADED', symbol: 'TCS-EQ' },
    ]);

    const r = await svc.createFromAlert(baseInput);

    expect(r.id).toBe('already-open');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('rejects SELL-direction alerts (BUY-only gate)', async () => {
    await expect(svc.createFromAlert({ ...baseInput, side: 'SELL' }))
      .rejects.toBeInstanceOf(TradeSellDirectionError);
    expect(repo.findActiveBySetupId).not.toHaveBeenCalled();
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('proceeds to create when no active entry exists for token (both dedups miss)', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([]); // no active watch for this token
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalled();
  });

  it('rejects a symbol traded within the last 45 minutes (R2 cooldown)', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([]);
    repo.wasTokenExecutedSince.mockResolvedValue(true);

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(
      TradeCooldownError,
    );
    expect(repo.createEntry).not.toHaveBeenCalled();
    // the `since` argument must be ~45 min before now
    const passedSince: Date = repo.wasTokenExecutedSince.mock.calls[0][1];
    expect(passedSince.getTime()).toBeCloseTo(Date.now() - TRADE_COOLDOWN_MS, -3); // +/-1s
  });

  it('creates entry, INITIAL event, subscribes feed on happy path', async () => {
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'TCS-EQ', side: 'BUY', initialPrice: 4000, initialScore: 72,
      profitTarget: 4150, profitTargetSource: 'indicator-sr', stopLossScore: 45,
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      watchEntryId: 'w1', eventType: 'INITIAL', price: 4000, score: 72,
    }));
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
  });

  it('subscribes options token too when strike picker returns one', async () => {
    strike.pick.mockResolvedValue({
      optionsToken: 'OPT-TOKEN', optionsType: 'CE', optionsStrike: 4000,
      optionsExpiry: new Date('2026-05-27'), optionsLotSize: 175,
      optionsSelectionScore: 0.7,
    });
    await svc.createFromAlert(baseInput);
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
    expect(feed.subscribeForWatch).toHaveBeenCalledWith('OPT-TOKEN', 'w1');
  });

  it('subscribes to the feed only AFTER the entry is executed (no WATCHING tick race)', async () => {
    // Bug B: subscribing to the live feed before executeEntry flips the
    // entry to TRADED let a tick land while status was still WATCHING —
    // applyTick then skipped the price loss-cut (gated `status==='TRADED'`).
    // The feed subscription must happen after the execute step resolves.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 4001 });

    await svc.createFromAlert(baseInput);

    expect(feed.subscribeForWatch).toHaveBeenCalled();
    expect(mockTrade.executeTrade).toHaveBeenCalled();
    const subscribeOrder = feed.subscribeForWatch.mock.invocationCallOrder[0];
    const executeOrder = mockTrade.executeTrade.mock.invocationCallOrder[0];
    expect(subscribeOrder).toBeGreaterThan(executeOrder);
  });

  it('auto-executes the paper trade after creating the entry', async () => {
    // Wire mocks to support the executeEntry path that runs at the tail of
    // createFromAlert. The user wants Chartink alert → score → auto-buy
    // without manual click.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1',
      token: '11536',
      symbol: 'TCS-EQ',
      side: 'BUY',
      status: 'WATCHING',
      initialPrice: 4000,
      initialScore: 72,
      initialBreakdown: { lotCount: 1 },
      optionsToken: null,
      optionsLotSize: null,
      profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({
      id: 'paper-trade-123',
      entryPrice: 4001,
    });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'TCS-EQ',
        side: 'BUY',
        // initialScore 72 -> capital 1,50,000; floor(150,000 / 4000) = 37
        quantity: 37,
        orderType: 'MARKET',
        positionType: 'INTRADAY',
        price: 4000,
      }),
    );
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
      executedPrice: 4001,
      paperTradeId: 'paper-trade-123',
    }));
  });

  it('sizes the auto-executed order within the per-trade risk cap', async () => {
    // Regression: the watch sizer built ~₹2,00,000 equity orders while the
    // RiskManager capped a single trade at maxCapitalPerTrade — so every
    // Chartink auto-execute was rejected and no paper trade ever filled.
    // The sized order value must never exceed the per-trade risk cap.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'BLUECHIP-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 2000 });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalled();
    const order = mockTrade.executeTrade.mock.calls[0][0];
    const orderValue = order.quantity * order.price;
    expect(orderValue).toBeLessThanOrEqual(DEFAULT_MAX_CAPITAL_PER_TRADE);
  });

  it('passes the entry numeric token (not the symbol) to executeTrade', async () => {
    // Regression: executeEntry passed entry.symbol as the `token`, so
    // findInstrumentId (which matches {symbol} OR {token}) could not resolve
    // the NSE instrument — stored by numeric token — and every equity
    // auto-execute died with "Instrument not found".
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockResolvedValue({ id: 'pt2', entryPrice: 4000 });

    await svc.createFromAlert(baseInput);

    expect(mockTrade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ token: '11536' }),
    );
  });

  it('leaves entry in WATCHING when auto-execute fails (e.g. insufficient cash)', async () => {
    // RiskManager raises an HttpException for cash shortfalls; the service
    // logs and swallows so the entry survives for manual retry.
    repo.findById = jest.fn().mockResolvedValue({
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
      status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
      optionsToken: null, optionsLotSize: null, profitTarget: 4150,
    });
    repo.update = jest.fn().mockResolvedValue({});
    mockTrade.executeTrade = jest.fn().mockRejectedValue(
      new Error('Insufficient paper cash: need ₹20,00,000, available ₹0'),
    );

    const result = await svc.createFromAlert(baseInput);

    // The entry was created — that part doesn't roll back.
    expect(repo.createEntry).toHaveBeenCalled();
    // …but it was never marked TRADED.
    expect(repo.update).not.toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
    }));
    // Caller gets the original (WATCHING) entry back.
    expect(result.id).toBe('w1');
  });
});

describe('WatchService.onTick', () => {
  let svc: WatchService;
  let repo: any;
  let feed: any;
  let gateway: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      // findById is used by unsubscribeEntry — provide a default resolved value
      findById: jest.fn().mockResolvedValue({ id: 'w1', token: '11536', optionsToken: null }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    gateway = { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: gateway },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('writes PRICE_CHANGE when |Δ| ≥ 0.25%', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4010, new Date('2026-05-13T10:00:00Z'));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'PRICE_CHANGE', price: 4010,
    }));
  });

  it('does NOT write PRICE_CHANGE when |Δ| < 0.25%', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4005, new Date('2026-05-13T10:00:00Z'));
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('transitions to TARGET_HIT when a TRADED BUY position reaches profitTarget', async () => {
    // Only a TRADED position records a real TARGET_HIT — an untraded WATCHING
    // entry that drifts to its target is MISSED instead (covered separately).
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'TRADED',
      initialPrice: 4000, executedPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      maxFavorable: 4000, maxAdverse: 4000, optionsToken: null,
    }]);
    await svc.onTick('11536', 4160, new Date('2026-05-13T10:00:00Z'));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'TARGET_HIT',
    }));
    expect(feed.unsubscribeForWatch).toHaveBeenCalledWith('11536', 'w1');
  });

  it('transitions to TARGET_HIT when a TRADED SELL position reaches profitTarget', async () => {
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'SELL', status: 'TRADED',
      initialPrice: 4000, executedPrice: 4000, lastEventPrice: 4000, profitTarget: 3850,
      maxFavorable: 4000, maxAdverse: 4000, optionsToken: null,
    }]);
    await svc.onTick('11536', 3840, new Date('2026-05-13T10:00:00Z'));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
  });

  it('drops a genuinely out-of-order tick (older than lastTickAt, fresh broker clock)', async () => {
    // Realistic timestamps: both within the broker-clock trust window, so
    // the out-of-order guard applies and the reordered tick is dropped.
    const now = Date.now();
    const lastTick = new Date(now - 1_000);  // last processed 1s ago
    const staleTick = new Date(now - 6_000); // this tick is 6s older
    repo.findActiveByToken.mockResolvedValue([{
      id: 'w1', token: '11536', side: 'BUY', status: 'WATCHING',
      initialPrice: 4000, lastEventPrice: 4000, profitTarget: 4150,
      lastTickAt: lastTick,
      maxFavorable: 4000, maxAdverse: 4000,
    }]);
    await svc.onTick('11536', 4010, staleTick);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.createEvent).not.toHaveBeenCalled();
  });
});

describe('WatchService.transitionStopped', () => {
  let svc: WatchService;
  let repo: any;
  let feed: any;

  beforeEach(async () => {
    repo = {
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', status: 'WATCHING', optionsToken: null,
      }),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { unsubscribeForWatch: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('a TRADED position that decays below its score floor transitions to STOPPED', async () => {
    // Only a real (TRADED) position records a STOPPED loss.
    repo.findById.mockResolvedValue({
      id: 'w1', token: '11536', status: 'TRADED', optionsToken: null,
    });
    await svc.transitionStopped('w1', 55, 'score-decay');
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SL_HIT_SCORE', score: 55,
    }));
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'sl-score-decay',
    }));
    expect(feed.unsubscribeForWatch).toHaveBeenCalled();
  });

  it('an UNTRADED (WATCHING) entry that decays is MISSED, not a phantom STOPPED', async () => {
    // beforeEach findById returns a WATCHING (never-executed) entry.
    await svc.transitionStopped('w1', 40, 'score-decay');
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'MISSED', closedReason: 'missed-untraded',
    }));
    const stopped = (repo.update.mock.calls as any[]).find((c) => c[1]?.status === 'STOPPED');
    expect(stopped).toBeUndefined();
  });

  it('transitionLossCut does not throw when the entry is not found (null entry)', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      svc.transitionLossCut('missing-id', 1990, -1200),
    ).resolves.not.toThrow();
  });
});

describe('WatchService — exits close the linked paper trade', () => {
  let svc: WatchService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', symbol: 'TCS-EQ', status: 'TRADED',
        optionsToken: null, paperTradeId: 'pt-1', currentPrice: 1990,
      }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    mockTrade.closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { unsubscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  it('transitionTargetHit closes the linked trade so cash is returned', async () => {
    await svc.transitionTargetHit('w1', 4160);
    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
  });

  it('transitionStopped closes the linked trade so cash is returned', async () => {
    await svc.transitionStopped('w1', 55, 'score-decay');
    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
  });

  // Regression: every exit transition that *has* a known trigger price MUST
  // forward it to closeTrade. Without it, the trade-execution fallback resolves
  // an exitPrice from the cached LTP at simulation time — which drifts from the
  // real trigger and silently under-/over-reports the realised P&L on the
  // linked Trade row. See POLICYBZR 2026-05-20: triggered at ₹1834.60 but the
  // Trade row recorded ₹1842.22, hiding ~₹823 of loss.

  it('transitionTargetHit forwards the trigger price as opts.exitPrice', async () => {
    await svc.transitionTargetHit('w1', 4160);
    expect(mockTrade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ exitPrice: 4160 }),
    );
  });

  it('transitionLossCut forwards the confirmed loss-cut price as opts.exitPrice', async () => {
    // No broker-adapter override on this describe block, so fetchLivePrice
    // returns null and the loss-cut keeps the original price argument.
    await svc.transitionLossCut('w1', 1990, -1200);
    expect(mockTrade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ exitPrice: 1990 }),
    );
  });

  // Score-decay / EOD / manual closes are NOT price-triggered, but they must
  // still forward the last mark (the entry's currentPrice tick) so a feed-blind
  // close marks the trade to that price instead of falling back to entryPrice
  // (which would book a real loss as ₹0 and understate realised losses).
  it('transitionStopped forwards the last mark price as opts.exitPrice', async () => {
    await svc.transitionStopped('w1', 55, 'score-decay');
    expect(mockTrade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ exitPrice: 1990 }),
    );
  });

  it('closeTraded forwards the last mark price as opts.exitPrice', async () => {
    await svc.closeTraded('w1', 'eod-square-off');
    expect(mockTrade.closeTrade).toHaveBeenCalledWith(
      'pt-1',
      expect.objectContaining({ exitPrice: 1990 }),
    );
  });
});

describe('WatchService.onTick — hard loss-cut', () => {
  // Reference price ₹2000 → qty = floor(200_000 / 2000) = 100 shares.
  // So a ₹1,000 loss = ₹10/share adverse move (₹2000 → ₹1990 for a BUY).
  let svc: WatchService;
  let repo: any;
  let feed: any;
  let gateway: any;
  let brokerAdapter: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', symbol: 'TCS-EQ', status: 'TRADED',
        side: 'BUY', executedPrice: 2000,
        optionsToken: null, paperTradeId: 'pt-1',
      }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    feed = { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() };
    gateway = { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn() };
    brokerAdapter = { getLiveQuote: jest.fn() };
    mockTrade.closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: gateway },
        { provide: TradeExecutionService, useValue: mockTrade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2200,
      optionsToken: null, optionsLotSize: null, paperTradeId: 'pt-1',
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      maxFavorable: 2000, maxAdverse: 2000, lastEventPrice: 2000, lastTickAt: null,
      ...overrides,
    };
  }

  it('cuts a TRADED entry whose open loss reaches ₹1,000', async () => {
    // ref=2000, qty=100. ltp=1990 → loss = -10 * 100 = -₹1,000 (exactly at threshold).
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);

    await svc.onTick('11536', 1990, new Date());

    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.anything());
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'SL_HIT_PRICE',
    }));
  });

  it('does NOT cut when the open loss is just under ₹1,000', async () => {
    // ltp=1990.5 → loss = -9.5 * 100 = -₹950, below the ₹1,000 threshold.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);

    await svc.onTick('11536', 1990.5, new Date());

    const lossCutUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.closedReason === 'loss-cut',
    );
    expect(lossCutUpdate).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('never loss-cuts a WATCHING entry', async () => {
    // Same -₹1,000 adverse move but the entry was never traded.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ status: 'WATCHING', executedPrice: null, paperTradeId: null }),
    ]);

    await svc.onTick('11536', 1990, new Date());

    const lossCutUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.closedReason === 'loss-cut',
    );
    expect(lossCutUpdate).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('loss-cuts even within the 10-minute grace window (fresh entry)', async () => {
    // executedAt = now → entry is brand new, well inside the score-decay
    // grace window. A price loss is a hard fact and must still cut.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ executedAt: new Date() }),
    ]);

    await svc.onTick('11536', 1985, new Date()); // loss = -15 * 100 = -₹1,500

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('loss-cuts a SELL entry when price rises against it by ≥ ₹1,000', async () => {
    // SELL ref=2000, qty=100. ltp=2010 → loss = -(2010-2000)*100 = -₹1,000.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ side: 'SELL', profitTarget: 1800 }),
    ]);

    await svc.onTick('11536', 2010, new Date());

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('hard-cuts at 0.4% of deployed capital (quantity x executedPrice) (R5)', async () => {
    // quantity 100, executedPrice 2000 -> deployed 200,000 -> SL = 0.4% = 800.
    // BUY: at ltp 1992 the loss is (1992-2000)*100 = -800 -> at threshold -> cut.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ quantity: 100 })]);

    await svc.onTick('11536', 1992, new Date());

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('does NOT hard-cut at -700 when the 0.4%-of-capital threshold is 800 (R5)', async () => {
    // ltp 1993 -> loss (1993-2000)*100 = -700, inside the 800 threshold.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ quantity: 100 })]);

    await svc.onTick('11536', 1993, new Date());

    const cut = (repo.update.mock.calls as any[]).find(
      (c) => c[1]?.closedReason === 'loss-cut',
    );
    expect(cut).toBeUndefined();
  });

  it('aborts the loss-cut when a fresh broker quote shows the trigger tick was a glitch', async () => {
    // The tick (1985) computes a -₹1,500 loss, but the broker's fresh quote
    // says the real price is 2001 — no loss. A single bad feed tick must not
    // trigger a real exit, so the cut is aborted on re-confirmation.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 2001 });

    await svc.onTick('11536', 1985, new Date());

    const lossCutUpdate = (repo.update.mock.calls as any[]).find(
      (call: any[]) => call[1]?.closedReason === 'loss-cut',
    );
    expect(lossCutUpdate).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('still loss-cuts when consecutive ticks carry a stale (non-advancing) broker timestamp', async () => {
    // Repro of the BSHSL freeze: the broker keeps emitting ticks whose
    // timestamp is hours behind wall-clock. The first such tick set
    // lastTickAt to that stale value; every later tick is <= it, so the
    // out-of-order guard dropped them ALL — applyTick never ran again and
    // the loss-cut (which lives inside applyTick) was silently disabled.
    // A bad broker clock must NEVER be able to wedge tick processing.
    const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ lastTickAt: staleTs }),
    ]);

    // New tick also carries the stale timestamp; ltp=1985 → loss -₹1,500.
    await svc.onTick('11536', 1985, staleTs);

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });
});

describe('WatchService.onTick — untraded alerts become MISSED, not TARGET_HIT', () => {
  let svc: WatchService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      // transitionTargetHit re-reads the entry to close its linked trade.
      findById: jest.fn().mockResolvedValue({
        id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
        status: 'TRADED', optionsToken: null, paperTradeId: 'pt-1',
      }),
      createEvent: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn().mockResolvedValue({}),
    };
    mockTrade.closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { subscribeForWatch: jest.fn(), unsubscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn(), emitEvent: jest.fn(), emitCreated: jest.fn(), emitEntry: jest.fn() } },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  const entry = (overrides: Record<string, any> = {}) => ({
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
    initialPrice: 2000, profitTarget: 2200, optionsToken: null,
    maxFavorable: 2000, maxAdverse: 2000, lastTickAt: null,
    ...overrides,
  });

  it('a WATCHING (untraded) entry that drifts past its target is MISSED — no phantom TARGET_HIT, no trade closed', async () => {
    repo.findActiveByToken.mockResolvedValue([
      entry({ status: 'WATCHING', executedPrice: null, paperTradeId: null }),
    ]);

    await svc.onTick('11536', 2200, new Date()); // price crosses the target

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({ status: 'MISSED' }));
    const phantom = (repo.update.mock.calls as any[]).find((c) => c[1]?.status === 'TARGET_HIT');
    expect(phantom).toBeUndefined();
    expect(mockTrade.closeTrade).not.toHaveBeenCalled();
  });

  it('a TRADED entry that reaches its target is still TARGET_HIT and closes the trade', async () => {
    repo.findActiveByToken.mockResolvedValue([
      entry({ status: 'TRADED', executedPrice: 2000, paperTradeId: 'pt-1' }),
    ]);

    await svc.onTick('11536', 2200, new Date());

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({ status: 'TARGET_HIT' }));
    expect(mockTrade.closeTrade).toHaveBeenCalledWith('pt-1', expect.objectContaining({ exitPrice: 2200 }));
  });
});

describe('WatchService.list — enrichment', () => {
  it('attaches scannerName, realizedPnl and realizedFees to each entry', async () => {
    const repo = {
      list: jest.fn().mockResolvedValue([
        { id: 'w1', alertId: 'a1', paperTradeId: 't1', liveTradeId: null, status: 'TARGET_HIT' },
        { id: 'w2', alertId: null, paperTradeId: null, liveTradeId: null, status: 'WATCHING' },
      ]),
      findScannerNames: jest.fn().mockResolvedValue(new Map([['a1', 'Scanner X']])),
      findTradeRealization: jest
        .fn()
        .mockResolvedValue(new Map([['t1', { pnl: 4200, fees: 117.25 }]])),
    };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: {} },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: {} },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    const svc = mod.get(WatchService);

    const result = await svc.list({ status: undefined, date: '2026-05-15' });

    expect(repo.list).toHaveBeenCalledWith({ status: undefined, date: '2026-05-15' });
    expect(result[0]).toMatchObject({
      id: 'w1',
      scannerName: 'Scanner X',
      realizedPnl: 4200,
      realizedFees: 117.25,
    });
    expect(result[1]).toMatchObject({
      id: 'w2',
      scannerName: null,
      realizedPnl: null,
      realizedFees: null,
    });
  });
});

describe('WatchService.executeEntry — 15:00 IST entry cutoff', () => {
  let svc: WatchService;
  let repo: any;
  let trade: any;
  let windowSpy: jest.SpyInstance;

  const watchingEntry = {
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY',
    status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
    optionsToken: null, optionsLotSize: null, profitTarget: 4150,
  };

  async function build() {
    repo = {
      findById: jest.fn().mockResolvedValue(watchingEntry),
      update: jest.fn().mockResolvedValue({}),
    };
    trade = { executeTrade: jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 4001 }) };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn().mockReturnValue({ target: 4080, source: 'fallback-2pct' }) } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { subscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn() } },
        { provide: TradeExecutionService, useValue: trade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 4000 }) } },
      ],
    }).compile();
    svc = mod.get(WatchService);
  }

  beforeEach(build);

  afterEach(() => {
    windowSpy?.mockRestore();
  });

  it('refuses to execute and leaves the entry WATCHING when outside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    // No broker call, entry never marked TRADED, no throw.
    expect(trade.executeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('logs a clear warning when refusing to execute outside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await svc.executeEntry('w1', { mode: 'paper' });

    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('TCS-EQ');
    expect(line.toLowerCase()).toMatch(/entry window|15:00/);
    warn.mockRestore();
  });

  it('executes normally and marks the entry TRADED when inside the entry window', async () => {
    windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'TRADED',
    }));
    expect(result).toMatchObject({ id: 'pt1' });
  });
});

describe('WatchService.executeEntry — live-quote pricing (Bug A)', () => {
  let svc: WatchService;
  let repo: any;
  let trade: any;
  let brokerAdapter: any;
  let target: any;

  const watchingEntry = {
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY', exchange: 'NSE',
    status: 'WATCHING', initialPrice: 4000, initialBreakdown: { lotCount: 1 },
    optionsToken: null, optionsLotSize: null, profitTarget: 4150,
  };

  beforeEach(async () => {
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') }); // 10:00 IST
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = {
      findById: jest.fn().mockResolvedValue(watchingEntry),
      update: jest.fn().mockResolvedValue({}),
    };
    trade = { executeTrade: jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 3800 }) };
    brokerAdapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 3800 }) };
    target = { compute: jest.fn().mockReturnValue({ target: 3876, source: 'fallback-2pct' }) };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: target },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: { subscribeForWatch: jest.fn() } },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn() } },
        { provide: TradeExecutionService, useValue: trade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('prices the order off the live quote, not the stale alert price', async () => {
    // Bug A: the Chartink trigger price (initialPrice) is 4000, but the live
    // market is 3800. The order must be priced off the live quote — opening
    // at a stale alert price births the position already mispriced.
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 3800 });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 3800 }),
    );
  });

  it('refuses to execute when no live quote is available (no stale-price fill)', async () => {
    // With no live quote, executeEntry used to fall back to the stale
    // Chartink trigger price. It must instead refuse to trade and leave the
    // entry WATCHING — never open a position at an unverified price.
    jest.spyOn(svc as any, 'delay').mockResolvedValue(undefined); // skip retry backoff
    brokerAdapter.getLiveQuote.mockRejectedValue(new Error('quote unavailable'));

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalledWith(
      'w1', expect.objectContaining({ status: 'TRADED' }),
    );
    expect(result).toBeNull();
  });

  it('retries the live quote and fills when a later attempt succeeds (transient feed blip)', async () => {
    // A momentary Angel feed/REST blip used to permanently miss the trade: the
    // single quote fetch failed → refused → MISSED. Now executeEntry retries a
    // few times before giving up, so a transient failure that recovers within
    // ~1s still fills.
    jest.spyOn(svc as any, 'delay').mockResolvedValue(undefined); // no real backoff wait
    brokerAdapter.getLiveQuote
      .mockRejectedValueOnce(new Error('feed blip'))
      .mockRejectedValueOnce(new Error('feed blip'))
      .mockResolvedValueOnce({ ltp: 3800 });

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(brokerAdapter.getLiveQuote).toHaveBeenCalledTimes(3);
    expect(trade.executeTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 3800 }));
    expect(result).not.toBeNull();
  });

  it('admits a price that moved within the chase tolerance (+2.5%, under the 3% gate)', async () => {
    // Evidence (tmp-upside-dist): of 42 entries the OLD 1% gate blocked, 93%
    // went on to hit target — prior intraday strength is a POSITIVE predictor
    // for this momentum strategy, not a reason to sit out. The gate is widened
    // to 3% so a +2.5% drift is now chased, not refused.
    repo.createEvent = jest.fn().mockResolvedValue({ id: 'e1' });
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 4100 }); // +2.5% from 4000

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 4100 }),
    );
    expect(result).not.toBeNull();
  });

  it('still refuses to chase a price that ran away beyond the 3% tolerance (+4%)', async () => {
    // The widened gate keeps a backstop against genuine runaway gaps: a move
    // past 3% from the alert is still refused and journaled.
    repo.createEvent = jest.fn().mockResolvedValue({ id: 'e1' });
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 4160 }); // +4% from 4000

    const result = await svc.executeEntry('w1', { mode: 'paper' });

    expect(result).toBeNull();
    expect(trade.executeTrade).not.toHaveBeenCalled();
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'NOT_TRADED',
        notes: expect.stringContaining('already moved'),
      }),
    );
  });

  it('persists the real filled quantity on the watch entry', async () => {
    // The watch entry must carry the actual traded quantity so P&L never
    // reconstructs floor(MAX_INVESTMENT / price).
    trade.executeTrade.mockResolvedValue({ id: 'pt1', entryPrice: 3800, quantity: 52 });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      quantity: 52,
    }));
  });

  it('re-anchors the profit target to the actual execution price', async () => {
    // initialPrice (the Chartink alert price) is 4000; the live fill is 3800.
    // The profit target must be recomputed off 3800 — leaving it on the stale
    // 4000 anchor makes the band the wrong width vs the real entry, so a
    // target set off the alert price can sit a sliver above (or below) entry
    // and "hit" on noise within seconds for a near-zero / negative P&L.
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 3800 });
    target.compute.mockReturnValue({ target: 3876, source: 'fallback-2pct' });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(target.compute).toHaveBeenCalledWith(
      expect.objectContaining({ entryPrice: 3800 }),
    );
    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      executedPrice: 3800,
      profitTarget: 3876,
      profitTargetSource: 'fallback-2pct',
    }));
  });

  it('sizes the order from the score-tiered capital, not a flat 2L (R4)', async () => {
    // initialScore 72 -> tier [65,75) -> capital 1,50,000; live quote 100.
    repo.findById.mockResolvedValue({ ...watchingEntry, initialScore: 72 });
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 100 });
    trade.executeTrade.mockResolvedValue({ id: 'pt1', entryPrice: 100, quantity: 1500 });

    await svc.executeEntry('w1', { mode: 'paper' });

    // qty = floor(150,000 / 100) = 1500
    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1500 }),
    );
  });
});

describe('WatchService.executeEntry — prefer fresh WS-cached LTP at fill (FIX 4)', () => {
  let svc: WatchService;
  let repo: any;
  let trade: any;
  let brokerAdapter: any;
  let feed: any;
  let now: Date;

  const watchingEntry = {
    id: 'w1', token: '11536', symbol: 'TCS-EQ', side: 'BUY', exchange: 'NSE',
    status: 'WATCHING', initialPrice: 4000, initialScore: 72, initialBreakdown: { lotCount: 1 },
    optionsToken: null, optionsLotSize: null, profitTarget: 4150,
  };

  beforeEach(async () => {
    now = new Date('2026-05-19T04:30:00Z'); // 10:00 IST
    jest.useFakeTimers({ now });
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = {
      findById: jest.fn().mockResolvedValue(watchingEntry),
      update: jest.fn().mockResolvedValue({}),
    };
    trade = { executeTrade: jest.fn().mockResolvedValue({ id: 'pt1', entryPrice: 3850 }) };
    // REST quote returns a DIFFERENT price so we can tell which source was used.
    brokerAdapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 3700 }) };
    feed = { subscribeForWatch: jest.fn(), getQuote: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn().mockReturnValue({ target: 3900, source: 'fallback-2pct' }) } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: feed },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: { emitTick: jest.fn() } },
        { provide: TradeExecutionService, useValue: trade },
        { provide: BROKER_ADAPTER_TOKEN, useValue: brokerAdapter },
      ],
    }).compile();
    svc = mod.get(WatchService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses a FRESH WS-cached LTP and skips the blocking REST quote', async () => {
    // A WS tick from 5s ago is fresh — fill off it, never hit the broker REST.
    feed.getQuote.mockReturnValue({ token: '11536', ltp: 3850, timestamp: new Date(now.getTime() - 5_000) });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(feed.getQuote).toHaveBeenCalledWith('11536');
    expect(brokerAdapter.getLiveQuote).not.toHaveBeenCalled();
    expect(trade.executeTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 3850 }));
  });

  it('falls back to the REST quote when the WS-cached tick is stale', async () => {
    // A WS tick from 5 minutes ago is stale (> 2-min fresh window) — ignore it
    // and fall through to the REST round-trip.
    feed.getQuote.mockReturnValue({ token: '11536', ltp: 9999, timestamp: new Date(now.getTime() - 5 * 60_000) });

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(brokerAdapter.getLiveQuote).toHaveBeenCalled();
    expect(trade.executeTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 3700 }));
  });

  it('falls back to the REST quote when there is no WS-cached tick', async () => {
    feed.getQuote.mockReturnValue(null);

    await svc.executeEntry('w1', { mode: 'paper' });

    expect(brokerAdapter.getLiveQuote).toHaveBeenCalled();
    expect(trade.executeTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 3700 }));
  });
});
