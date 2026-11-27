/**
 * Trade agent exit authority (spec §3 #9, #10; plan Task 7 step 2): under TRADE_AGENT_AUTHORITY=live the legacy
 * live sellers cannot sell — closeTrade on a LIVE trade from any non-owner caller (watch-monitor, the signal-review
 * REJECT) is refused with `[exit-authority] legacy live close refused`, and the order tracker's automatic
 * STOPLOSS_MARKET at entry is not placed. The owner's controller close and the kill switch stay allowed. Paper
 * trades and authority off: unchanged.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { AuthorityStatePort } from '../../exit-authority/exit-authority.tokens';
import { LEGACY_LIVE_CLOSE_REFUSED, TradeExecutionService } from './trade-execution.service';
import { OrderTrackerService } from './order-tracker.service';

const LIVE: AuthorityStatePort = { isLive: () => true };
const OFF: AuthorityStatePort = { isLive: () => false };

function harness(authority: AuthorityStatePort | undefined, isPaperTrade = false) {
  const trades: Record<string, any> = {
    t1: {
      id: 't1', status: 'OPEN', side: 'BUY', quantity: 50, entryPrice: 100, isPaperTrade, positionType: 'INTRADAY',
      notes: null, orderId: 'o-entry', instrument: { symbol: 'NIFTY27NOV24000CE', token: '123', exchange: 'NFO' },
    },
  };
  const repo = {
    getTradeById: jest.fn(async (id: string) => trades[id] ?? null),
    updateTrade: jest.fn(async (id: string, data: any) => (trades[id] = { ...trades[id], ...data })),
    claimClose: jest.fn(async (id: string, _e: unknown, data: any) => ((trades[id] = { ...trades[id], ...data }), true)),
    getOpenTrades: jest.fn(async () => Object.values(trades).filter((t: any) => t.status === 'OPEN')),
    createTradeEvent: jest.fn(async () => ({})),
  };
  const broker = {
    placeOrder: jest.fn(async () => ({ orderId: 'o-close', status: 'COMPLETE' })),
    getLiveQuote: jest.fn(async () => ({ ltp: 95 })),
    getPositions: jest.fn(async (): Promise<unknown[]> => [{ symbol: 'NIFTY27NOV24000CE', exchange: 'NFO', side: 'BUY', quantity: 50, averagePrice: 100, ltp: 95, pnl: -250 }]),
  };
  const paper = { simulateOrder: jest.fn(async () => ({ orderId: 'p1', status: 'FILLED', fillPrice: 95, message: 'ok' })), applyExitAccounting: jest.fn() };
  const risk = { activateKillSwitch: jest.fn(), getDailyRiskStatus: jest.fn(async () => ({})) };
  const positions = { removePosition: jest.fn(), reducePosition: jest.fn(), updatePositionPnL: jest.fn() };
  const gateway = { emitTradeUpdate: jest.fn(), emitKillSwitchActivated: jest.fn(), emitRiskStatus: jest.fn() };
  const settings = { activateKillSwitch: jest.fn(async () => undefined) };
  const feed = { getQuote: jest.fn(() => null) };
  const svc = new TradeExecutionService(
    broker as never, paper as never, risk as never, { trackOrder: jest.fn() } as never, positions as never,
    repo as never, gateway as never, settings as never, feed as never, {} as never, authority,
  );
  return { svc, broker, paper, trades };
}

describe('legacy live closeTrade under TRADE_AGENT_AUTHORITY', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('live: a watch-monitor close of a LIVE trade is refused (409), logged, and no order is placed', async () => {
    const h = harness(LIVE);
    const err = await h.svc.closeTrade('t1', { reason: 'target-hit', exitPrice: 120 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(String((err as Error).message)).toContain(LEGACY_LIVE_CLOSE_REFUSED);
    expect(errors.mock.calls.some(([m]) => String(m).startsWith('[exit-authority] legacy live close refused'))).toBe(true);
    expect(h.broker.placeOrder).not.toHaveBeenCalled();
    expect(h.trades.t1.status).toBe('OPEN');
  });

  it('live: the signal-review REJECT close (legacy string reason) is refused the same way', async () => {
    const h = harness(LIVE);
    await expect(h.svc.closeTrade('t1', 'Claude review: rejected')).rejects.toThrow(LEGACY_LIVE_CLOSE_REFUSED);
    expect(h.broker.placeOrder).not.toHaveBeenCalled();
  });

  it('live: the owner controller close (ownerAction) still sells the live trade', async () => {
    const h = harness(LIVE);
    await h.svc.closeTrade('t1', { reason: 'owner', ownerAction: true });
    expect(h.broker.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.trades.t1.status).toBe('CLOSED');
  });

  it('live: the kill switch still closes every live trade whose broker position is open', async () => {
    const h = harness(LIVE);
    const r = await h.svc.closeAllPositions('max daily loss');
    expect(r.closed).toBe(1);
    expect(h.broker.getPositions).toHaveBeenCalledTimes(1);
    expect(h.broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('live: the kill switch SKIPS a stale live trades row whose broker position is flat (never sells an already-flat position)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = harness(LIVE);
    h.broker.getPositions.mockResolvedValueOnce([{ symbol: 'NIFTY27NOV24000CE', exchange: 'NFO', side: 'BUY', quantity: 0, averagePrice: 100, ltp: 95, pnl: 0 }]);
    const r = await h.svc.closeAllPositions('max daily loss');
    expect(r.closed).toBe(0);
    expect(h.broker.placeOrder).not.toHaveBeenCalled();
    expect(h.trades.t1.status).toBe('OPEN');
    expect(warn.mock.calls.some(([m]) => String(m).includes('flat at the broker'))).toBe(true);
  });

  it('live: the broker position check failing → the live row is skipped with an ERROR, not sold blind', async () => {
    const h = harness(LIVE);
    h.broker.getPositions.mockRejectedValueOnce(new Error('AG8001 Invalid Token'));
    const r = await h.svc.closeAllPositions('max daily loss');
    expect(r.closed).toBe(0);
    expect(h.broker.placeOrder).not.toHaveBeenCalled();
    expect(errors.mock.calls.some(([m]) => String(m).includes('SKIPPED, not sold blind'))).toBe(true);
  });

  it('live: a PAPER trade is closed by the kill switch with no broker read', async () => {
    const h = harness(LIVE, true);
    const r = await h.svc.closeAllPositions('max daily loss');
    expect(r.closed).toBe(1);
    expect(h.broker.getPositions).not.toHaveBeenCalled();
  });

  it.each([['off', OFF], ['port absent', undefined]] as const)('%s: the kill switch closes the live trade as today (no broker position read)', async (_n, authority) => {
    const h = harness(authority);
    const r = await h.svc.closeAllPositions('max daily loss');
    expect(r.closed).toBe(1);
    expect(h.broker.getPositions).not.toHaveBeenCalled();
    expect(h.broker.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('live: a PAPER trade closes as today (the paper engines are untouched)', async () => {
    const h = harness(LIVE, true);
    await h.svc.closeTrade('t1', { reason: 'target-hit', exitPrice: 120 });
    expect(h.paper.simulateOrder).toHaveBeenCalledTimes(1);
    expect(h.trades.t1.status).toBe('CLOSED');
  });

  it.each([['off', OFF], ['port absent', undefined]] as const)('%s: a watch-monitor close of a LIVE trade sells as today', async (_n, authority) => {
    const h = harness(authority);
    await h.svc.closeTrade('t1', { reason: 'target-hit', exitPrice: 120 });
    expect(h.broker.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.trades.t1.status).toBe('CLOSED');
  });
});

describe('order tracker auto STOPLOSS at entry under TRADE_AGENT_AUTHORITY', () => {
  afterEach(() => jest.restoreAllMocks());

  function tracker(authority: AuthorityStatePort | undefined) {
    const broker = { placeOrder: jest.fn(async () => ({ orderId: 'sl-1', status: 'OPEN' })) };
    const svc = new OrderTrackerService(broker as never, { updateTrade: jest.fn() } as never, { emitTradeUpdate: jest.fn() } as never, authority);
    const tracked = {
      orderId: 'o1', tradeId: 't1', pollCount: 0, intervalHandle: null, autoStoploss: 90,
      originalRequest: { symbol: 'X', token: '1', exchange: 'NFO', side: 'BUY', orderType: 'MARKET', quantity: 50, positionType: 'INTRADAY' },
    };
    const place = () => (svc as unknown as { placeAutoStoploss(t: unknown): Promise<void> }).placeAutoStoploss(tracked);
    return { broker, place };
  }

  it('live: the STOPLOSS_MARKET at entry is not placed (warned)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = tracker(LIVE);
    await t.place();
    expect(t.broker.placeOrder).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([m]) => String(m).includes('legacy auto STOPLOSS at entry not placed'))).toBe(true);
  });

  it.each([['off', OFF], ['port absent', undefined]] as const)('%s: placed as today', async (_n, authority) => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const t = tracker(authority);
    await t.place();
    expect(t.broker.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ orderType: 'STOPLOSS_MARKET', side: 'SELL', triggerPrice: 90 }));
  });
});
