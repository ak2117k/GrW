import { agentEvents } from './agent-events';
import { AgentBusyError } from './agent-protocol';
import { GlobalLimiter, globalLimiterFrom, isQuotaError } from './global-limiter';

describe('GlobalLimiter', () => {
  afterEach(() => agentEvents.removeAllListeners());

  it('non-trading jobs share total - reserve; the reserve is trading-only', async () => {
    const l = new GlobalLimiter({ total: 4, tradingReserve: 2 });
    const a = await l.acquire('news.ideas', false, 0);
    await l.acquire('assist.advisor', false, 0);
    await expect(l.acquire('news.impact', false, 0)).rejects.toBeInstanceOf(AgentBusyError);
    const t1 = await l.acquire('sentinel.judge', true, 0);
    await l.acquire('sentinel.judge', true, 0);
    await expect(l.acquire('sentinel.judge', true, 0)).rejects.toBeInstanceOf(AgentBusyError);
    t1();
    t1(); // idempotent
    expect(l.stats().inFlight).toBe(3);
    a();
    expect(l.stats()).toMatchObject({ inFlight: 2, inFlightNonTrading: 1 });
  });

  it('trading may use the non-trading share too', async () => {
    const l = new GlobalLimiter({ total: 3, tradingReserve: 1 });
    for (let i = 0; i < 3; i++) await l.acquire('sentinel.judge', true, 0);
    await expect(l.acquire('news.ideas', false, 0)).rejects.toBeInstanceOf(AgentBusyError);
  });

  it('a waiter gets the next freed slot within its deadline, else AgentBusyError', async () => {
    const l = new GlobalLimiter({ total: 2, tradingReserve: 1 });
    const r = await l.acquire('news.ideas', false, 0);
    const waiting = l.acquire('news.impact', false, 1000);
    expect(l.stats().waiting).toBe(1);
    r();
    const r2 = await waiting;
    expect(typeof r2).toBe('function');
    const late = l.acquire('assist.news', false, 20);
    const err = await late.catch((e) => e);
    expect(err).toBeInstanceOf(AgentBusyError);
    expect(err.name).toBe('AgentBusyError');
    expect(l.stats().waiting).toBe(0);
  });

  it('trading waiters are admitted before non-trading ones', async () => {
    const l = new GlobalLimiter({ total: 2, tradingReserve: 0 });
    const r1 = await l.acquire('x', false, 0);
    await l.acquire('y', false, 0);
    const order: string[] = [];
    const nt = l.acquire('news', false, 1000).then((rel) => (order.push('news'), rel));
    const tr = l.acquire('judge', true, 1000).then((rel) => (order.push('judge'), rel));
    r1();
    (await tr)();
    await nt;
    expect(order).toEqual(['judge', 'news']);
  });

  it('a 429 halves the non-trading share for 60 s and emits quota once per squeeze', async () => {
    let t = 0;
    const l = new GlobalLimiter({ total: 16, tradingReserve: 6, now: () => t });
    const quota = jest.fn();
    agentEvents.on('quota', quota);
    expect(l.nonTradingLimit()).toBe(10);
    l.noteQuota('news.ideas');
    l.noteQuota('news.ideas');
    expect(quota).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledWith({ job: 'news.ideas' });
    expect(l.nonTradingLimit()).toBe(5);
    for (let i = 0; i < 5; i++) await l.acquire('n', false, 0);
    await expect(l.acquire('n', false, 0)).rejects.toBeInstanceOf(AgentBusyError);
    const tr = await l.acquire('sentinel.judge', true, 0);
    expect(typeof tr).toBe('function');
    t = 60_001;
    expect(l.nonTradingLimit()).toBe(10);
    l.noteQuota('x');
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('env defaults 16 / 6, overrides honoured, reserve clamped below total', () => {
    const d = globalLimiterFrom({});
    expect([d.total, d.tradingReserve]).toEqual([16, 6]);
    const o = globalLimiterFrom({ AGENTS_GLOBAL_CONCURRENCY: '8', AGENTS_TRADING_RESERVE: '3' });
    expect([o.total, o.tradingReserve]).toEqual([8, 3]);
    const c = globalLimiterFrom({ AGENTS_GLOBAL_CONCURRENCY: '4', AGENTS_TRADING_RESERVE: '9' });
    expect([c.total, c.tradingReserve]).toEqual([4, 3]);
  });

  it('isQuotaError', () => {
    expect(isQuotaError({ status: 429 })).toBe(true);
    expect(isQuotaError(new (class RateLimitError extends Error {})('x'))).toBe(true);
    expect(isQuotaError(new Error('8: RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isQuotaError(new Error('boom'))).toBe(false);
    expect(isQuotaError({ status: 500 })).toBe(false);
  });
});
