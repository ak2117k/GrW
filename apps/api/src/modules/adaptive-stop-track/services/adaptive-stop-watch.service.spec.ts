import { Test } from '@nestjs/testing';
import { AdaptiveStopWatchService, AdaptiveStopRiskBudgetError, AdaptiveStopDecisionGateError } from './adaptive-stop-watch.service';
import { AdaptiveStopWatchRepository } from '../repositories/adaptive-stop-watch.repository';
import { AdaptiveStopTradeRepository } from '../repositories/adaptive-stop-trade.repository';
import { AdaptiveStopAccountService } from './adaptive-stop-account.service';
import { AdaptiveStopTradeExecutionService } from './adaptive-stop-trade-execution.service';
import { AdaptiveStopGateway } from '../gateways/adaptive-stop.gateway';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { resolveStop, sizeQuantity } from '../adaptive-stop-math';
import { atr } from '../../signal-generator/strategies/indicators';
import { GRACE_MS } from '../constants';

// Build 30 5m candles around `close` with a constant ±range/2 high/low spread so
// ATR(14) is deterministic. true-range collapses to (high-low)=range each bar
// (close is flat), so ATR(14) === range.
function makeCandles(close = 2000, range = 6, n = 30): any[] {
  return Array.from({ length: n }, () => ({
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 1000,
  }));
}

describe('AdaptiveStopWatchService.createFromAlert — vol-stop + risk-first sizing', () => {
  let svc: AdaptiveStopWatchService;
  let repo: any, trades: any, account: any, exec: any, adapter: any;

  const baseInput = {
    alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
    side: 'BUY' as const, initialPrice: 2000, initialScore: 42,
    initialBreakdown: { checks: [] },
  };

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
      getLastClosedPnlForToken: jest.fn().mockResolvedValue(null),
      countOpenTrades: jest.fn().mockResolvedValue(0),
      createEntry: jest.fn().mockResolvedValue({ id: 'aw1', token: '11536' }),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findById: jest.fn().mockResolvedValue({
        id: 'aw1', token: '11536', side: 'BUY', initialPrice: 2000,
        status: 'WATCHING', exchange: 'NSE',
      }),
    };
    trades = {};
    account = { admit: jest.fn().mockResolvedValue(undefined), applyEntry: jest.fn() };
    exec = { openTrade: jest.fn().mockResolvedValue({ id: 'at1', entryPrice: 2000 }) };
    const gateway = { emitEntry: jest.fn() };
    adapter = {
      getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }),
      getHistoricalData: jest.fn().mockResolvedValue(makeCandles(2000, 6, 30)),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AdaptiveStopWatchService,
        { provide: AdaptiveStopWatchRepository, useValue: repo },
        { provide: AdaptiveStopTradeRepository, useValue: trades },
        { provide: AdaptiveStopAccountService, useValue: account },
        { provide: AdaptiveStopTradeExecutionService, useValue: exec },
        { provide: AdaptiveStopGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(AdaptiveStopWatchService);
  });

  it('persists the decision-gate result (skipped + reason) on the entry', async () => {
    // The default candles carry no timestamps → the gate skips (fails open).
    // That skip must now be RECORDED so we can measure how often the gate is
    // bypassed live (the cause of bad entries slipping through).
    await svc.createFromAlert(baseInput);
    const createCall = repo.createEntry.mock.calls[0][0];
    expect(typeof createCall.gateSkipped).toBe('boolean');
    expect(createCall.gateSkipped).toBe(true);
    expect(typeof createCall.gateReason).toBe('string');
    expect(createCall.gateReason.length).toBeGreaterThan(0);
  });

  it('retries the 15m fetch before the gate gives up (transient feed blip)', async () => {
    jest.spyOn(svc as any, 'delay').mockResolvedValue(undefined); // no real backoff wait
    adapter.getHistoricalData
      .mockRejectedValueOnce(new Error('feed blip'))
      .mockResolvedValueOnce(makeCandles(2000, 6, 30));
    await svc.createFromAlert(baseInput);
    const fifteenMinCalls = adapter.getHistoricalData.mock.calls.filter((c: any[]) => c[2] === '15m');
    expect(fifteenMinCalls.length).toBe(2); // retried the 15m fetch once
    expect(repo.createEntry).toHaveBeenCalled();
  });

  it('creates the entry with stopPrice/stopPct/riskAmount/atrAtEntry/stopBasis and risk-first qty', async () => {
    // Sanity: with flat-close candles ATR(14) === range (6).
    const candles = makeCandles(2000, 6, 30);
    const atr5m = atr(
      candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14,
    );
    expect(atr5m).toBeCloseTo(6, 6);
    const stop = resolveStop(2000, atr5m as number);

    await svc.createFromAlert(baseInput);

    const createCall = repo.createEntry.mock.calls[0][0];
    expect(createCall.atrAtEntry).toBeCloseTo(atr5m as number, 6);
    expect(createCall.stopPrice).toBeCloseTo(stop.stopPrice, 6);
    expect(createCall.stopPct).toBeCloseTo(stop.stopPct, 6);
    expect(createCall.riskAmount).toBe(800);
    expect(createCall.stopBasis).toBe(stop.basis);

    // qty must be the risk-first size, NOT TRADE_CAPITAL / price.
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      quantity: sizeQuantity(stop.stopDist),
      entryPrice: 2000,
      side: 'BUY',
    }));
  });

  it('persists TRADED + the risk-first qty after openTrade', async () => {
    const stop = resolveStop(2000, 6);
    await svc.createFromAlert(baseInput);
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({
      status: 'TRADED', paperTradeId: 'at1', executedPrice: 2000,
      quantity: sizeQuantity(stop.stopDist),
    }));
  });

  it('rejects with AdaptiveStopRiskBudgetError when sized qty < 1 (stop too wide) — no entry, no trade', async () => {
    // High entry (₹50000) + a huge ATR → stop distance caps at MAX_STOP_PCT (2.5%)
    // = ₹1250, which exceeds RISK_PER_TRADE (₹800) → sizeQuantity = floor(800/1250) = 0.
    // Sanity-check the math before asserting the rejection path.
    const entry = 50000;
    const candles = makeCandles(entry, 4000, 30); // flat-close → ATR(14) === range (4000)
    const atr5m = atr(
      candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), 14,
    );
    const stop = resolveStop(entry, atr5m as number);
    expect(stop.basis).toBe('cap');
    expect(sizeQuantity(stop.stopDist)).toBe(0);

    // initialPrice === live so the upside gate (step 5) passes (moveFromAlert = 0).
    adapter.getLiveQuote.mockResolvedValue({ ltp: entry });
    adapter.getHistoricalData.mockResolvedValue(candles);

    await expect(
      svc.createFromAlert({ ...baseInput, initialPrice: entry }),
    ).rejects.toBeInstanceOf(AdaptiveStopRiskBudgetError);

    // The gate fires before entry creation and execution.
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(exec.openTrade).not.toHaveBeenCalled();
  });

  it('decision gate REJECTS an extended / no-support entry — no entry, no trade', async () => {
    // A 15m series trending 1900→2000 ending at "now" so the live fill (2000)
    // sits at the top: far from any support (nearest round support ~1950, 2.5%
    // away). Anchored to real now because evaluateGate uses new Date() for the
    // session-day filter.
    const now = Date.now();
    const rising = Array.from({ length: 16 }, (_, i) => {
      const c = 1900 + i * 6.7; // ~1900 → ~2000
      return { timestamp: new Date(now - (16 - i) * 15 * 60_000), high: c + 1, low: c - 1, close: c, volume: 1000 };
    });
    adapter.getLiveQuote.mockResolvedValue({ ltp: 2000 });
    adapter.getHistoricalData.mockResolvedValue(rising);

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(AdaptiveStopDecisionGateError);
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(exec.openTrade).not.toHaveBeenCalled();
  });

  it('decision gate SKIPS (fails open) on timestampless/insufficient candles — entry proceeds', async () => {
    // The default mock candles carry no timestamp ⇒ the gate cannot evaluate ⇒
    // it fails OPEN and the entry is still created (existing behaviour intact).
    await svc.createFromAlert(baseInput);
    expect(repo.createEntry).toHaveBeenCalled();
    expect(exec.openTrade).toHaveBeenCalled();
  });
});

describe('AdaptiveStopWatchService.onTick — per-entry stop + 2-min grace', () => {
  let svc: AdaptiveStopWatchService;
  let repo: any, exec: any;

  // entry @2000, vol-stop computed from ATR=6: stopDist=7.2 (1.2×6), stopPrice=1992.8.
  const stop = resolveStop(2000, 6);

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'aw1', token: '11536', symbol: 'TCS', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2040,
      stopPrice: stop.stopPrice,
      executedAt: new Date(Date.now() - 10 * 60_000), // 10 min ago → past grace by default
      paperTradeId: 'at1', quantity: 100, remainingQty: 100,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      slBreachCount: 0,
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    exec = { closeTrade: jest.fn().mockResolvedValue({}) };
    const gateway = { emitEntry: jest.fn() };
    const adapter = {
      getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }),
      getHistoricalData: jest.fn().mockResolvedValue([]),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AdaptiveStopWatchService,
        { provide: AdaptiveStopWatchRepository, useValue: repo },
        { provide: AdaptiveStopTradeRepository, useValue: {} },
        { provide: AdaptiveStopAccountService, useValue: {} },
        { provide: AdaptiveStopTradeExecutionService, useValue: exec },
        { provide: AdaptiveStopGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(AdaptiveStopWatchService);
  });

  it('within GRACE_MS of executedAt, a price below stopPrice does NOT loss-cut', async () => {
    // executedAt = now → inGrace. ltp well below stopPrice.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ executedAt: new Date(), slBreachCount: 0 }),
    ]);
    await svc.onTick('11536', stop.stopPrice - 5, new Date());
    expect(exec.closeTrade).not.toHaveBeenCalled();
    // No STOPPED transition, and breach counter NOT incremented during grace.
    expect(repo.update).not.toHaveBeenCalledWith('aw1', expect.objectContaining({ status: 'STOPPED' }));
    expect(repo.update).not.toHaveBeenCalledWith('aw1', expect.objectContaining({ slBreachCount: 1 }));
  });

  it('after grace: FIRST breach increments slBreachCount, does NOT cut', async () => {
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ slBreachCount: 0 }), // executedAt 10 min ago (past grace)
    ]);
    await svc.onTick('11536', stop.stopPrice - 1, new Date());
    expect(exec.closeTrade).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({ slBreachCount: 1 }));
    expect(repo.update).not.toHaveBeenCalledWith('aw1', expect.objectContaining({ status: 'STOPPED' }));
  });

  it('after grace: SECOND consecutive breach loss-cuts (capped at stopPrice)', async () => {
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ slBreachCount: 1 }),
    ]);
    await svc.onTick('11536', stop.stopPrice - 5, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('at1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: stop.stopPrice, // capped at stop, not the overshot ltp
    }));
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('resets slBreachCount when price recovers above stop after a prior breach', async () => {
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ slBreachCount: 1 }),
    ]);
    await svc.onTick('11536', stop.stopPrice + 5, new Date()); // back above stop
    expect(exec.closeTrade).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({ slBreachCount: 0 }));
  });

  it('emits a PRICE_CHANGE event on a >=0.25% move with no transition firing', async () => {
    // lastEventPrice=2000; ltp=2010 → +0.5% (>=0.25%). Below the +1% partial
    // trigger (2020), below the +2% target (2040), above the stop — so no
    // transition/partial fires and the price-change block is reached.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ lastEventPrice: 2000 }),
    ]);
    await svc.onTick('11536', 2010, new Date());

    expect(exec.closeTrade).not.toHaveBeenCalled();

    const priceChangeCalls = repo.createEvent.mock.calls.filter(
      (c: any[]) => c[0].eventType === 'PRICE_CHANGE',
    );
    expect(priceChangeCalls).toHaveLength(1);
    expect(priceChangeCalls[0][0]).toEqual(expect.objectContaining({
      watchEntryId: 'aw1',
      eventType: 'PRICE_CHANGE',
      price: 2010,
    }));
    expect(priceChangeCalls[0][0].priceDelta).not.toBeNull();
    expect(priceChangeCalls[0][0].priceDelta).toBeCloseTo(0.5, 6);

    expect(repo.update).toHaveBeenCalledWith('aw1', { lastEventPrice: 2010 });
  });

  it('does NOT emit a PRICE_CHANGE event on a <0.25% move', async () => {
    // lastEventPrice=2000; ltp=2003 → +0.15% (<0.25%). No price-change event.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({ lastEventPrice: 2000 }),
    ]);
    await svc.onTick('11536', 2003, new Date());

    const priceChangeCalls = repo.createEvent.mock.calls.filter(
      (c: any[]) => c[0].eventType === 'PRICE_CHANGE',
    );
    expect(priceChangeCalls).toHaveLength(0);
    expect(repo.update).not.toHaveBeenCalledWith('aw1', { lastEventPrice: 2003 });
  });
});

describe('AdaptiveStopWatchService.onTick — ATR-based trailing give-back', () => {
  let svc: AdaptiveStopWatchService;
  let repo: any, exec: any;

  // entry @2000, atrAtEntry=20 → trail give-back = 1.0×20 = 20 (1.0%, within
  // the [0.6%,1.5%] band). vol-stop from ATR=6 → stopPrice 1992.8.
  const stop = resolveStop(2000, 6);

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'aw1', token: '11536', symbol: 'TCS', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2040,
      stopPrice: stop.stopPrice, atrAtEntry: 20,
      executedAt: new Date(Date.now() - 10 * 60_000), // past grace
      paperTradeId: 'at1', quantity: 100, remainingQty: 100,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      slBreachCount: 0, lastEventPrice: 2000,
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      createEvent: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    exec = { closeTrade: jest.fn().mockResolvedValue({}) };
    const gateway = { emitEntry: jest.fn() };
    const adapter = {
      getLiveQuote: jest.fn().mockResolvedValue({ ltp: 2000 }),
      getHistoricalData: jest.fn().mockResolvedValue([]),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AdaptiveStopWatchService,
        { provide: AdaptiveStopWatchRepository, useValue: repo },
        { provide: AdaptiveStopTradeRepository, useValue: {} },
        { provide: AdaptiveStopAccountService, useValue: {} },
        { provide: AdaptiveStopTradeExecutionService, useValue: exec },
        { provide: AdaptiveStopGateway, useValue: gateway },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(AdaptiveStopWatchService);
  });

  it('partial-exit arms an ATR-based trail (1.0×ATR below price), NOT the flat 0.5%', async () => {
    // ltp=2030 (+1.5%, past the +1% partial trigger). Trail = 2030 - 20 = 2010.
    // The old flat 0.5% would have been 2030×0.995 = 2019.85 (much tighter).
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 2030, new Date());

    expect(exec.closeTrade).toHaveBeenCalledWith('at1', expect.objectContaining({
      reason: 'partial-exit', quantity: 50,
    }));
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({
      trailingHighWater: 2030,
      trailingStopPrice: 2010,
    }));
  });

  it('a shallow pullback that the flat 0.5% trail would have cut is now HELD', async () => {
    // Already partial-exited, high-water 2030, ATR trail at 2010. Price dips to
    // 2015 — below the old flat-trail level (2019.85) but above the ATR trail.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({
        partialExitedAt: new Date(), trailingHighWater: 2030,
        trailingStopPrice: 2010, remainingQty: 50,
      }),
    ]);
    await svc.onTick('11536', 2015, new Date());
    expect(exec.closeTrade).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalledWith('aw1', expect.objectContaining({
      closedReason: 'trailing-stop',
    }));
  });

  it('exits trailing-stop only when price breaks the (wider) ATR give-back', async () => {
    // Same armed state; price breaks below the ATR trail (2010).
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({
        partialExitedAt: new Date(), trailingHighWater: 2030,
        trailingStopPrice: 2010, remainingQty: 50,
      }),
    ]);
    await svc.onTick('11536', 2008, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('at1', expect.objectContaining({
      reason: 'trailing-stop', exitPrice: 2008,
    }));
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({
      status: 'EXITED', closedReason: 'trailing-stop',
    }));
  });

  it('ratchets the ATR trail up on a new high-water', async () => {
    // Armed at high-water 2030 / trail 2010; price makes a new high 2038 (still
    // below the +2% target 2040, so target-hit does not pre-empt). New trail =
    // 2038 - 20 = 2018.
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({
        partialExitedAt: new Date(), trailingHighWater: 2030,
        trailingStopPrice: 2010, remainingQty: 50,
      }),
    ]);
    await svc.onTick('11536', 2038, new Date());
    expect(repo.update).toHaveBeenCalledWith('aw1', expect.objectContaining({
      trailingHighWater: 2038,
      trailingStopPrice: 2018,
    }));
    // New high is not a trail breach — no exit.
    expect(repo.update).not.toHaveBeenCalledWith('aw1', expect.objectContaining({
      closedReason: 'trailing-stop',
    }));
  });
});
