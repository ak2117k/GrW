import { UserFeedManager } from './user-feed-manager.service';

function fakeSession() {
  const listeners: any = {};
  let count = 0;
  return {
    ensureConnected: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(async (t: any[]) => {
      count += t.length;
    }),
    unsubscribe: jest.fn(async (t: any[]) => {
      count -= t.length;
    }),
    activeTokenCount: () => count,
    onTick: (l: any) => (listeners.tick = l),
    onState: (l: any) => (listeners.state = l),
    dispose: jest.fn().mockResolvedValue(undefined),
    getCandles: jest.fn().mockResolvedValue([{ timestamp: new Date(), open: 1, high: 2, low: 0, close: 1, volume: 10 }]),
    getQuote: jest.fn().mockResolvedValue({ token: '1', ltp: 100 }),
    getCandleWindow: jest.fn().mockResolvedValue([]),
    __listeners: listeners,
  };
}

it('creates one session per user and ref-counts tokens', async () => {
  const sessions: any[] = [];
  const factory = jest.fn(() => {
    const s = fakeSession();
    sessions.push(s);
    return s;
  });
  const mgr = new UserFeedManager(factory as any, { idleMs: 120000, maxSessions: 40 });
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]); // 2nd viewer of same token
  expect(factory).toHaveBeenCalledTimes(1);
  await mgr.unsubscribe('u1', [{ token: '1', exchange: 'NSE' }]); // still 1 ref left
  expect(sessions[0].unsubscribe).not.toHaveBeenCalled();
  await mgr.unsubscribe('u1', [{ token: '1', exchange: 'NSE' }]); // ref hits 0
  expect(sessions[0].unsubscribe).toHaveBeenCalled();
});

it('tears down an idle session after idleMs', async () => {
  jest.useFakeTimers();
  const sessions: any[] = [];
  const factory = jest.fn(() => {
    const s = fakeSession();
    sessions.push(s);
    return s;
  });
  const mgr = new UserFeedManager(factory as any, { idleMs: 1000, maxSessions: 40 });
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  mgr.releaseUser('u1');
  jest.advanceTimersByTime(1001);
  await Promise.resolve();
  expect(sessions[0].dispose).toHaveBeenCalled();
  jest.useRealTimers();
});

it('fetchCandles delegates to the user session (creating it on first use)', async () => {
  const sessions: any[] = [];
  const factory = jest.fn(() => {
    const s = fakeSession();
    sessions.push(s);
    return s;
  });
  const mgr = new UserFeedManager(factory as any, { idleMs: 120000, maxSessions: 40 });
  const from = new Date('2026-05-15T03:45:00.000Z');
  const to = new Date('2026-05-15T05:45:00.000Z');
  const candles = await mgr.fetchCandles('u1', '111', 'NSE', '1m', from, to);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(sessions[0].getCandles).toHaveBeenCalledWith('111', 'NSE', '1m', from, to);
  expect(candles).toHaveLength(1);
  expect(candles[0].open).toBe(1);
});

it('fetchQuote delegates to the user session', async () => {
  const s = fakeSession();
  const mgr = new UserFeedManager((() => s) as any, { idleMs: 120000, maxSessions: 40 });
  const quote = await mgr.fetchQuote('u1', '111', 'NSE');
  expect(s.getQuote).toHaveBeenCalledWith('111', 'NSE');
  expect(quote).toEqual({ token: '1', ltp: 100 });
});

it('routes ticks through the global handler tagged by userId', async () => {
  const s = fakeSession();
  const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
  const seen: any[] = [];
  mgr.setHandlers(
    (uid, t) => seen.push([uid, t]),
    () => {},
  );
  await mgr.subscribe('u1', [{ token: '1', exchange: 'NSE' }]);
  s.__listeners.tick({ token: '1', ltp: 100 });
  expect(seen).toEqual([['u1', { token: '1', ltp: 100 }]]);
});

describe('pins (the market hub shares the owner session)', () => {
  it('pin on an existing user reuses the one session', async () => {
    const factory = jest.fn(() => fakeSession());
    const mgr = new UserFeedManager(factory as any, { idleMs: 1000, maxSessions: 40 });
    await mgr.subscribe('owner', [{ token: '1', exchange: 'NSE' }]); // browser
    await mgr.pin('owner', [{ token: '2', exchange: 'NSE' }]); // hub
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('pins survive releaseUser and block idle teardown', async () => {
    jest.useFakeTimers();
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    await mgr.pin('owner', [{ token: '2', exchange: 'NSE' }]);
    await mgr.subscribe('owner', [{ token: '1', exchange: 'NSE' }]);
    mgr.releaseUser('owner'); // browser tab closed
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(s.dispose).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('subscribes a token once whether the browser, the hub or both hold it', async () => {
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    const t = { token: '1', exchange: 'NSE' };
    await mgr.pin('owner', [t]);
    await mgr.subscribe('owner', [t]);
    expect(s.subscribe).toHaveBeenCalledTimes(1);
    await mgr.unsubscribe('owner', [t]); // browser leaves; hub still pins
    expect(s.unsubscribe).not.toHaveBeenCalled();
    await mgr.unpin('owner', [t]); // last holder
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releaseUser unsubscribes browser-only tokens when pins keep the session alive', async () => {
    // Without pins, teardown cleaned these up; pins block teardown, so release must.
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    const pinned = { token: '2', exchange: 'NSE' };
    const browserOnly = { token: '1', exchange: 'NSE' };
    await mgr.pin('owner', [pinned]);
    await mgr.subscribe('owner', [browserOnly, pinned]);
    mgr.releaseUser('owner');
    await Promise.resolve();
    expect(s.unsubscribe).toHaveBeenCalledWith([browserOnly]);
  });

  it('delivers ticks to extra listeners alongside the gateway handler', async () => {
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    const gateway = jest.fn();
    const hub = jest.fn();
    mgr.setHandlers(gateway, jest.fn());
    const off = mgr.addTickListener(hub);
    await mgr.pin('owner', []);
    s.__listeners.tick({ token: '1', ltp: 5 });
    expect(gateway).toHaveBeenCalledWith('owner', { token: '1', ltp: 5 });
    expect(hub).toHaveBeenCalledWith('owner', { token: '1', ltp: 5 });
    off();
    s.__listeners.tick({ token: '1', ltp: 6 });
    expect(hub).toHaveBeenCalledTimes(1);
  });
});

it('fetchCandleWindow runs one window on the user’s own session', async () => {
  const s = fakeSession();
  const mgr = new UserFeedManager((() => s) as any, { idleMs: 120000, maxSessions: 40 });
  const from = new Date(0);
  const to = new Date(60_000);
  await mgr.fetchCandleWindow('u1', { token: '26000', exchange: 'NSE' }, 'ONE_HOUR', from, to);
  expect(s.getCandleWindow).toHaveBeenCalledWith('26000', 'NSE', 'ONE_HOUR', from, to);
});
