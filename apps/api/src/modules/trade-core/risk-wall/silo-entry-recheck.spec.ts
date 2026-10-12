import { ForbiddenException } from '@nestjs/common';
import * as marketHours from '../../../common/utils/market-hours';
import { AdaptiveStopWatchService } from '../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../anand-dual-track/services/anand-dual-track.service';
import { AutoExecutionService } from '../../auto-execution/services/auto-execution.service';
import { BreakoutSwingService } from '../../breakout-swing-track/services/breakout-swing.service';
import { SellFuturesService } from '../../sell-futures-track/services/sell-futures.service';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { UngatedWatchService } from '../../ungated-track/services/ungated-watch.service';
import { WatchService } from '../../watch-monitor/services/watch.service';
import { CoreKillSwitchEntryBlockedError, setCoreKillSwitchReader } from './kill-gate';

/**
 * The race the SP2 M2 review found: an entry passes the core kill-switch gate, then
 * spends seconds on quotes / candles / broker login before it writes the position. If
 * the switch is engaged in that window (and the cascade square-off has already run),
 * the late write would open a position nobody squares off. Each entry must re-check
 * the gate just before the write that opens the position.
 *
 * Each block: the gate is OFF at the first check, the mocked slow I/O engages the
 * switch, and nothing may be opened. A control case (never engaged) proves the mocks
 * reach that same write, so the refusal is the re-check and not a mock gap.
 */
let engaged = false;
const engage = () => { engaged = true; };
beforeEach(() => {
  engaged = false;
  setCoreKillSwitchReader({ isOn: async () => engaged, isOnForPlatform: async () => engaged, invalidate: () => undefined });
});
afterEach(() => {
  jest.restoreAllMocks();
  setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
});

const construct = <T>(C: new (...a: any[]) => T, args: unknown[]): T => new C(...args);
const settle = (p: Promise<unknown>) => p.then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: undefined, e }));

const alertInput = {
  alertId: 'a1', setupId: 's1', symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'BUY' as const,
  initialPrice: 2500, initialScore: 80, initialBreakdown: {}, scannerName: 'Anand 100Hull >200 hull',
};

/** Repo/account/exec doubles shared by the ungated and adaptive-stop createFromAlert paths. */
function equityTrackDoubles() {
  const repo = {
    findActiveByToken: jest.fn(async () => []),
    wasTokenExecutedSince: jest.fn(async () => false),
    getLastClosedPnlForToken: jest.fn(async () => null),
    countOpenTrades: jest.fn(async () => 0),
    createEntry: jest.fn(async () => ({ id: 'e1' })),
    createEvent: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
  };
  const account = { admit: jest.fn(async () => undefined) };
  const exec = { openTrade: jest.fn(async () => ({ id: 't1' })) };
  const adapter = { getLiveQuote: jest.fn(async () => { if (slowQuoteEngages) engage(); return { ltp: 2500 }; }) };
  return { repo, account, exec, adapter };
}
let slowQuoteEngages = true;
beforeEach(() => { slowQuoteEngages = true; });

describe('ungated-track: UngatedWatchService.createFromAlert re-checks after the quote fetch', () => {
  function svc() {
    const d = equityTrackDoubles();
    const s = construct(UngatedWatchService, [d.repo, {}, d.account, d.exec, {}, d.adapter]);
    return { ...d, s };
  }
  it('opens nothing when the switch is engaged during the quote fetch', async () => {
    const { s, repo, exec } = svc();
    const { e } = await settle(s.createFromAlert(alertInput));
    expect(e).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(exec.openTrade).not.toHaveBeenCalled();
  });
  it('control: opens the position when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, repo, exec } = svc();
    await s.createFromAlert(alertInput);
    expect(repo.createEntry).toHaveBeenCalledTimes(1);
    expect(exec.openTrade).toHaveBeenCalledTimes(1);
  });
});

describe('adaptive-stop-track: AdaptiveStopWatchService.createFromAlert re-checks after the quote, gate and ATR fetches', () => {
  function svc() {
    const d = equityTrackDoubles();
    const s = construct(AdaptiveStopWatchService, [d.repo, {}, d.account, d.exec, {}, d.adapter]);
    jest.spyOn(s as never, 'evaluateGate' as never).mockResolvedValue({ pass: true, skipped: false, reason: 'ok', detail: {} } as never);
    jest.spyOn(s as never, 'atr5mFor' as never).mockResolvedValue(10 as never);
    return { ...d, s };
  }
  it('opens nothing when the switch is engaged during the quote fetch', async () => {
    const { s, repo, exec } = svc();
    const { e } = await settle(s.createFromAlert(alertInput));
    expect(e).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(exec.openTrade).not.toHaveBeenCalled();
  });
  it('control: opens the position when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, repo, exec } = svc();
    await s.createFromAlert(alertInput);
    expect(repo.createEntry).toHaveBeenCalledTimes(1);
    expect(exec.openTrade).toHaveBeenCalledTimes(1);
  });
});

describe('sell-futures-track: SellFuturesService.createFromAlert re-checks after the futures quote fetch', () => {
  function svc() {
    const repo = {
      findActiveByToken: jest.fn(async () => []),
      wasTokenExecutedSince: jest.fn(async () => false),
      countOpenTrades: jest.fn(async () => 0),
      createEntry: jest.fn(async () => ({ id: 'e1' })),
      createEvent: jest.fn(async () => undefined),
      update: jest.fn(async () => undefined),
    };
    const trades = { createTrade: jest.fn(async () => ({ id: 't1' })) };
    const account = { admit: jest.fn(async () => undefined), ensureMargin: jest.fn(async () => undefined), applyEntry: jest.fn(async () => undefined) };
    const selector = { resolve: jest.fn(async () => ({ token: '99001', exchange: 'NFO', lotSize: 250, tradingsymbol: 'RELIANCE26OCTFUT', expiry: new Date('2026-10-27') })) };
    const adapter = { getLiveQuote: jest.fn(async () => { if (slowQuoteEngages) engage(); return { ltp: 2510 }; }) };
    const s = construct(SellFuturesService, [repo, trades, account, selector, adapter, {}]);
    return { s, repo, trades };
  }
  it('opens nothing when the switch is engaged during the quote fetch', async () => {
    const { s, repo, trades } = svc();
    const { e } = await settle(s.createFromAlert({ ...alertInput, side: 'SELL' }));
    expect(e).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(repo.createEntry).not.toHaveBeenCalled();
    expect(trades.createTrade).not.toHaveBeenCalled();
  });
  it('control: opens the short when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, repo, trades } = svc();
    await s.createFromAlert({ ...alertInput, side: 'SELL' });
    expect(repo.createEntry).toHaveBeenCalledTimes(1);
    expect(trades.createTrade).toHaveBeenCalledTimes(1);
  });
});

describe('breakout-swing-track: BreakoutSwingService.createFromAlert re-checks after the quote and candle fetches', () => {
  function svc() {
    const repo = {
      findActiveBySymbol: jest.fn(async () => null),
      createQueuedEntry: jest.fn(async () => ({ id: 'b1' })),
    };
    const adapter = { getLiveQuote: jest.fn(async () => { if (slowQuoteEngages) engage(); return { ltp: 100 }; }) };
    const s = construct(BreakoutSwingService, [repo, adapter]);
    jest.spyOn(s as never, 'nearestResistance' as never).mockResolvedValue(100.5 as never);
    jest.spyOn(s as never, 'prevDayClose' as never).mockResolvedValue(95 as never);
    return { s, repo };
  }
  const input = { alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 100, scoreBreakdown: {} };
  it('queues nothing when the switch is engaged during the quote fetch', async () => {
    const { s, repo } = svc();
    const { e } = await settle(s.createFromAlert(input));
    expect(e).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(repo.createQueuedEntry).not.toHaveBeenCalled();
  });
  it('control: queues the resting order when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, repo } = svc();
    await s.createFromAlert(input);
    expect(repo.createQueuedEntry).toHaveBeenCalledTimes(1);
  });
});

describe('watch-monitor: WatchService.executeEntry re-checks after the live price fetch', () => {
  function svc() {
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    const repo = {
      findById: jest.fn(async () => ({
        id: 'we_1', status: 'WATCHING', symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'BUY',
        initialPrice: 2500, initialScore: 80, initialBreakdown: {},
      })),
      update: jest.fn(async () => ({})),
      createEvent: jest.fn(async () => undefined),
    };
    const trade = { executeTrade: jest.fn(async () => ({ id: 't1', entryPrice: 2500, quantity: 10 })) };
    const s = construct(WatchService, [repo, {}, {}, {}, {}, { emitEntry: jest.fn() }, trade]);
    jest.spyOn(s as never, 'fetchLivePrice' as never).mockImplementation((async () => { if (slowQuoteEngages) engage(); return 2500; }) as never);
    return { s, trade };
  }
  it('opens nothing (returns null, as the early refusal does) when the switch is engaged during the price fetch', async () => {
    const { s, trade } = svc();
    expect(await s.executeEntry('we_1')).toBeNull();
    expect(trade.executeTrade).not.toHaveBeenCalled();
  });
  it('control: reaches the trade engine when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, trade } = svc();
    await settle(s.executeEntry('we_1'));
    expect(trade.executeTrade).toHaveBeenCalledTimes(1);
  });
});

describe('anand-dual-track: AnandDualTrackService.createEntries re-checks after the per-track guard reads', () => {
  function svc() {
    const repo = {
      bumpLeadStat: jest.fn(async () => undefined),
      findActiveTradedBySymbol: jest.fn(async () => { if (slowQuoteEngages) engage(); return null; }),
      hasTargetHitTodayBySymbol: jest.fn(async () => false),
      hasLossTodayBySymbol: jest.fn(async () => false),
      createIntradayEntry: jest.fn(async () => ({ id: 'i1', symbol: 'INFY' })),
      createSwingEntry: jest.fn(async () => ({ id: 's1', symbol: 'INFY' })),
    };
    return { s: construct(AnandDualTrackService, [repo]), repo };
  }
  const input = { symbol: 'INFY', token: '1594', hitPrice: 1500, alertId: 'a1', scoreBreakdown: {} } as never;
  it('creates neither entry when the switch is engaged during the guard reads', async () => {
    const { s, repo } = svc();
    await expect(s.createEntries(input)).resolves.toBeUndefined();
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
  });
  it('control: creates both entries when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, repo } = svc();
    await s.createEntries(input);
    expect(repo.createIntradayEntry).toHaveBeenCalledTimes(1);
    expect(repo.createSwingEntry).toHaveBeenCalledTimes(1);
  });
});

describe('auto-execution: AutoExecutionService.execute re-checks this user’s switch after the broker login', () => {
  const prevLive = process.env.LIVE_TRADING_ENABLED;
  beforeEach(() => { process.env.LIVE_TRADING_ENABLED = 'true'; });
  afterEach(() => { if (prevLive === undefined) delete process.env.LIVE_TRADING_ENABLED; else process.env.LIVE_TRADING_ENABLED = prevLive; });
  function svc() {
    const placeOrder = jest.fn(async () => ({ status: 'PLACED', orderId: 'o1', message: 'ok' }));
    const claims = { claim: jest.fn(async () => ({ acquired: true })), markFailed: jest.fn(async () => undefined), markPlaced: jest.fn(async () => undefined) };
    const audit = { append: jest.fn(async () => undefined) };
    const s = construct(AutoExecutionService, [
      { hasActive: jest.fn(async () => true) },
      { hasAcceptedCurrent: jest.fn(async () => true) },
      { autoTradeConsent: { findUnique: jest.fn(async () => ({ enabled: true, killSwitch: false, riskPerTrade: 1000, maxCapital: 100000 })) } },
      {},
      { isActive: () => false },
      { sizeOrder: jest.fn(() => ({ quantity: 1, lots: 1 })) },
      { validateTrade: jest.fn(async () => ({ allowed: true })) },
      claims,
      // Decrypt + ephemeral broker login: the slow window.
      { withDecryptedCredentials: jest.fn(async (_u: string, _m: unknown, fn: (c: unknown) => unknown) => { if (slowQuoteEngages) engage(); return fn({}); }) },
      { withSession: jest.fn(async (_c: unknown, fn: (s: unknown) => unknown) => fn({ placeOrder })) },
      audit,
    ]);
    return { s, placeOrder, claims, audit };
  }
  const job = { userId: 'user_A', signal: { symbol: 'INFY', token: '1594', segment: 'INTRADAY', side: 'BUY', entryId: 'e1', entryPrice: 1500 }, idempotencyKey: 'k1' } as never;
  it('places no order when the switch is engaged during the broker login, and records USER_KILL_SWITCH without retrying', async () => {
    const { s, placeOrder, claims, audit } = svc();
    await expect(s.execute(job)).resolves.toBeUndefined();
    expect(placeOrder).not.toHaveBeenCalled();
    expect(claims.markFailed).toHaveBeenCalledWith('k1', 'USER_KILL_SWITCH');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ORDER_REJECTED', userId: 'user_A', meta: expect.objectContaining({ reason: 'USER_KILL_SWITCH' }),
    }));
  });
  it('control: places the order when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, placeOrder } = svc();
    await s.execute(job);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
});

describe('trade-engine: TradeExecutionService.executeTrade (watch, auto-trade, universe scanner, manual) re-checks before placing', () => {
  function svc() {
    const paper = { simulateOrder: jest.fn(async () => ({ orderId: 'P1', status: 'FILLED', fillPrice: 100, message: 'ok' })) };
    const repo = {
      findInstrumentId: jest.fn(async () => { if (slowQuoteEngages) engage(); return 'inst1'; }),
      createTrade: jest.fn(async () => { throw new Error('stop after createTrade'); }),
    };
    const s = construct(TradeExecutionService, [
      null, paper, { validateTrade: jest.fn(async () => ({ allowed: true })) }, {}, {}, repo, {},
      { getSettings: jest.fn(async () => ({ paperTrading: true })) }, {}, { snapshot: jest.fn(async () => null) },
    ]);
    return { s, paper, repo };
  }
  const dto = { symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'BUY', orderType: 'MARKET', quantity: 1, positionType: 'INTRADAY', price: 100 } as never;
  it('places and persists nothing when the switch is engaged during the pre-order reads', async () => {
    const { s, paper, repo } = svc();
    const { e } = await settle(s.executeTrade(dto));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(paper.simulateOrder).not.toHaveBeenCalled();
    expect(repo.createTrade).not.toHaveBeenCalled();
  });
  it('control: places the order when the switch stays off', async () => {
    slowQuoteEngages = false;
    const { s, paper } = svc();
    await settle(s.executeTrade(dto));
    expect(paper.simulateOrder).toHaveBeenCalledTimes(1);
  });
});
