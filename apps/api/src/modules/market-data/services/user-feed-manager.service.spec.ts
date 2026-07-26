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
