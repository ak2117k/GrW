import { Test } from '@nestjs/testing';
import { UngatedWatchService, UngatedSymbolDupError, UngatedScannerNotAllowedError } from './ungated-watch.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import {
  UngatedPaperAccountService, TRADE_CAPITAL, MAX_CONCURRENT,
  UngatedCapitalExhaustedError, UngatedPositionCapError,
} from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedWatchGateway } from '../gateways/ungated-watch.gateway';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

describe('UngatedWatchService.createFromAlert', () => {
  let svc: UngatedWatchService;
  let repo: any, trades: any, account: any, exec: any;

  const baseInput = {
    alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
    side: 'BUY' as const, initialPrice: 2000, initialScore: 42,
    initialBreakdown: { checks: [] },
    // Hull scanner so the gate-0 Hull-only filter (default ON) passes for the
    // existing gate/exec tests below; the dedicated gate-0 block overrides this.
    scannerName: 'Anand 100Hull >200 hull',
  };

  // The Hull-only gate reads process.env.UNGATED_HULL_ONLY at call time. Save /
  // restore it around every test so a per-case override never leaks.
  const ORIGINAL_HULL_ONLY = process.env.UNGATED_HULL_ONLY;
  afterEach(() => {
    if (ORIGINAL_HULL_ONLY === undefined) delete process.env.UNGATED_HULL_ONLY;
    else process.env.UNGATED_HULL_ONLY = ORIGINAL_HULL_ONLY;
  });

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
      getLastClosedPnlForToken: jest.fn().mockResolvedValue(null),
      countOpenTrades:   jest.fn().mockResolvedValue(0),
      createEntry:       jest.fn().mockResolvedValue({ id: 'uw1', token: '11536' }),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
      findById:          jest.fn().mockResolvedValue({
        id: 'uw1', token: '11536', side: 'BUY', initialPrice: 2000,
        status: 'WATCHING', exchange: 'NSE',
      }),
    };
    trades = {};
    account = {
      admit: jest.fn().mockResolvedValue(undefined),
      applyEntry: jest.fn(),
    };
    exec = {
      openTrade: jest.fn().mockResolvedValue({ id: 'ut1', entryPrice: 2000 }),
    };
    const gateway = { emitEntry: jest.fn() };
    // Default: live quote returns the same price as Chartink hit so existing
    // assertions still pass unchanged. Tests that want to assert divergent
    // entry pricing override this mock per-case.
    const adapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: UngatedWatchGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
    (svc as any).__adapter = adapter; // expose for per-test overrides
  });

  // ── Gate 0: Hull-only scanner filter ─────────────────────────────────────

  it('rejects a non-Hull scanner with toggle ON (default) and creates no entry', async () => {
    process.env.UNGATED_HULL_ONLY = 'true';
    await expect(
      svc.createFromAlert({ ...baseInput, scannerName: 'ANAND HIGH GAINER BULLISH MAY26' }),
    ).rejects.toBeInstanceOf(UngatedScannerNotAllowedError);
    expect(repo.findActiveByToken).not.toHaveBeenCalled();
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(exec.openTrade).not.toHaveBeenCalled();
  });

  it('rejects a null scanner name with toggle ON (fail-closed)', async () => {
    process.env.UNGATED_HULL_ONLY = 'true';
    await expect(
      svc.createFromAlert({ ...baseInput, scannerName: null }),
    ).rejects.toBeInstanceOf(UngatedScannerNotAllowedError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('passes gate 0 for a Hull scanner with toggle ON (no scanner error)', async () => {
    process.env.UNGATED_HULL_ONLY = 'true';
    // Hull scanner must NOT throw the scanner-not-allowed error — it proceeds
    // through the remaining gates and opens the trade on the happy path.
    await expect(
      svc.createFromAlert({ ...baseInput, scannerName: 'Anand 100Hull >200 hull' }),
    ).resolves.toBeDefined();
    expect(exec.openTrade).toHaveBeenCalled();
  });

  it('passes gate 0 for a non-Hull scanner when UNGATED_HULL_ONLY=false', async () => {
    process.env.UNGATED_HULL_ONLY = 'false';
    await expect(
      svc.createFromAlert({ ...baseInput, scannerName: 'ANAND HIGH GAINER BULLISH MAY26' }),
    ).resolves.toBeDefined();
    expect(exec.openTrade).toHaveBeenCalled();
  });

  it('rejects when the same token already has a non-terminal entry (symbol-dup)', async () => {
    repo.findActiveByToken.mockResolvedValue([{ id: 'prev', token: '11536' }]);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedSymbolDupError);
  });

  it('rejects SELL-direction alerts (BUY-only gate)', async () => {
    const { UngatedSellDirectionError } = await import('./ungated-watch.service');
    await expect(svc.createFromAlert({ ...baseInput, side: 'SELL' }))
      .rejects.toBeInstanceOf(UngatedSellDirectionError);
    expect(repo.findActiveByToken).not.toHaveBeenCalled();
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('rejects with UngatedStaleEntryError when live price has moved > 1% above alert price', async () => {
    // initialPrice = 2000, ltp = 2021 → moveFromAlert = 1.05% > 1% → blocked
    const { UngatedStaleEntryError } = await import('./ungated-watch.service');
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 2021 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedStaleEntryError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('allows entry when live price moved < 1% above alert price (normal delay)', async () => {
    // initialPrice = 2000, ltp = 2019 → moveFromAlert = 0.95% < 1% → passes gate
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 2019 });
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalled();
  });

  it('anchors profitTarget to live fill price (not stale Chartink price)', async () => {
    // ltp = 1990 (stock dipped below alert price) → passes gate
    // profitTarget must be 1990 * 1.03 = 2049.7, not initialPrice * 1.03 = 2060
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 1990 });
    await svc.createFromAlert(baseInput);
    const createCall = repo.createEntry.mock.calls[0][0];
    expect(createCall.profitTarget).toBeCloseTo(1990 * 1.03, 2);
  });

  it('rejects with UngatedCooldownError when the token was executed within the last 45 min', async () => {
    // Regression: ASHAPURMIN 2026-05-22 — 09:46:00 loss-cut, re-entered
    // 09:50:17 (4 min later) and loss-cut again. The cooldown constant
    // existed in code but the check wasn't wired into createFromAlert.
    const { UngatedCooldownError } = await import('./ungated-watch.service');
    repo.wasTokenExecutedSince.mockResolvedValue(true);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedCooldownError);
  });

  it('rejects with UngatedLastLossError when last closed trade was a loss', async () => {
    const { UngatedLastLossError } = await import('./ungated-watch.service');
    repo.getLastClosedPnlForToken.mockResolvedValue(-120);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedLastLossError);
    expect(repo.createEntry).not.toHaveBeenCalled();
  });

  it('allows entry when last closed trade was profitable', async () => {
    repo.getLastClosedPnlForToken.mockResolvedValue(80);
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalled();
  });

  it('allows entry when no prior closed trade exists (first time)', async () => {
    repo.getLastClosedPnlForToken.mockResolvedValue(null);
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalled();
  });

  it('forwards account.admit failures (capital / cap / kill-switch)', async () => {
    account.admit.mockRejectedValue(new UngatedCapitalExhaustedError(50_000));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedCapitalExhaustedError);
  });

  it('on admission, sizes qty = floor(2L / initialPrice) and opens the trade', async () => {
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      quantity: Math.floor(TRADE_CAPITAL / 2000),
      entryPrice: 2000,
      side: 'BUY',
    }));
  });

  it('always sizes at least 1 share even when price exceeds TRADE_CAPITAL', async () => {
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 250_000 });
    await svc.createFromAlert({ ...baseInput, initialPrice: 250_000 });
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  });

  it('uses the LIVE broker quote (not Chartink hit price) for entryPrice + qty', async () => {
    // Regression: HONASA 2026-05-22 — ungated entered at the stale Chartink
    // hit price (₹389.35) while gated used a fresh live quote (₹393.12),
    // producing opposite-sign P&L on the SAME trade. Both tracks must now
    // anchor to the live broker quote at execute time for the A/B
    // comparison to be apples-to-apples.
    // ltp=1990 (slightly below initialPrice=2000): original target=2040, remaining=2.51% → gate passes.
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 1990 }); // Chartink said 2000; live is 1990
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 1990, // live quote, not 2000
      quantity: Math.floor(TRADE_CAPITAL / 1990),
    }));
  });

  it('rejects with UngatedNoQuoteError when the live quote returns 0', async () => {
    const { UngatedNoQuoteError } = await import('./ungated-watch.service');
    (svc as any).__adapter.getLiveQuote.mockResolvedValue({ ltp: 0 });
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedNoQuoteError);
    expect(exec.openTrade).not.toHaveBeenCalled();
  });

  it('rejects with UngatedNoQuoteError when the live quote throws', async () => {
    const { UngatedNoQuoteError } = await import('./ungated-watch.service');
    (svc as any).__adapter.getLiveQuote.mockRejectedValue(new Error('broker timeout'));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedNoQuoteError);
    expect(exec.openTrade).not.toHaveBeenCalled();
  });

  it('sets the entry to TRADED and persists paperTradeId after openTrade', async () => {
    await svc.createFromAlert(baseInput);
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TRADED', paperTradeId: 'ut1', executedPrice: 2000,
    }));
  });
});

describe('UngatedWatchService.onTick — transitions', () => {
  let svc: UngatedWatchService;
  let repo: any, account: any, exec: any;

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'uw1', token: '11536', symbol: 'TCS', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2040,
      paperTradeId: 'ut1', quantity: 100, remainingQty: 100,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      // Default to slBreachCount=1 so existing SL tests still exercise the
      // exit path (second breach). New two-strike-specific tests override
      // slBreachCount explicitly to assert first-breach behaviour.
      slBreachCount: 1,
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById:          jest.fn(),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
    };
    account = {};
    exec = { closeTrade: jest.fn().mockResolvedValue({}) };
    const gateway = { emitEntry: jest.fn() };
    const adapter = { getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: { } },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: UngatedWatchGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
  });

  it('BUY: ltp >= profitTarget → target-hit, forwards exitPrice', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 2045, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'target-hit', exitPrice: 2045,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
  });

  it('hard loss-cut at -1.5% of deployed → forwards exitPrice', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    // SL threshold price = 2000 * (1 - 0.015) = 1970; ltp at 1970 breaches -1.5%.
    await svc.onTick('11536', 1970, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: 1970,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('caps exit price at SL threshold when 30s poll already overshot below SL (BUY)', async () => {
    // Regression: 30s REST polling gap — stock fell from 2000 to 1950 within one window.
    // SL threshold is 2000 * 0.985 = 1970. Without the cap, exitPrice = 1950 → loss > 1.5%.
    // With the cap, exitPrice is pinned at 1970 regardless of how far ltp fell.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 1950, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: 1970,
    }));
  });

  // Partial-exit + trailing-stop tests removed 2026-06-27: those exit paths
  // were deleted so the ungated track holds full size to the +3% target or the
  // -1.5% two-strike hard stop (pure-hold, matching the candle-replay backtest).

  // ── Two-strike stop-hunt guard ───────────────────────────────────────────

  it('two-strike: does NOT exit on first SL breach — increments slBreachCount to 1', async () => {
    // slBreachCount starts at 0 → first breach must not exit, only increment.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ slBreachCount: 0 })]);
    // ltp=1970 is exactly at the SL threshold (2000*0.985=1970), loss = -3000
    await svc.onTick('11536', 1970, new Date());
    // No exit should have been triggered
    expect(exec.closeTrade).not.toHaveBeenCalled();
    // slBreachCount must be incremented to 1
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      slBreachCount: 1,
    }));
    // Entry must NOT be closed/stopped
    expect(repo.update).not.toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED',
    }));
  });

  it('two-strike: exits on second consecutive SL breach (slBreachCount=1 → exit)', async () => {
    // slBreachCount=1 means we already saw one breach; this tick is the second.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ slBreachCount: 1 })]);
    await svc.onTick('11536', 1970, new Date());
    // Should have exited on this tick
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut',
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('two-strike: resets slBreachCount to 0 when price recovers above SL between breaches', async () => {
    // slBreachCount=1 (had one breach), but now ltp=2000 (above SL threshold 1970)
    // → price recovered, counter must be reset to 0, no exit.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ slBreachCount: 1 })]);
    // ltp=2000 is above the SL threshold so no breach this tick
    await svc.onTick('11536', 2000, new Date());
    // No exit
    expect(exec.closeTrade).not.toHaveBeenCalled();
    // slBreachCount reset to 0
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      slBreachCount: 0,
    }));
    expect(repo.update).not.toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED',
    }));
  });
});
