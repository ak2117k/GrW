import { UserFeedSession } from './user-feed-session';
import type { FeedState } from './user-feed.types';

function makeDeps() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const ws = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    fetchData: jest.fn(),
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
    }),
    handlers,
  };
  const wsFactory = jest.fn().mockReturnValue(ws);
  const smartApi = {
    generateSession: jest.fn().mockResolvedValue({
      data: { jwtToken: 'jwt', feedToken: 'feed' },
    }),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  // Vault lease that just hands fake decrypted creds to the callback.
  const withCreds = jest.fn(async (_userId: string, cb: (c: any) => Promise<any>) =>
    cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' }),
  );
  return { ws, wsFactory, smartApi, withCreds };
}

it('connects using per-user feedToken and marks state live', async () => {
  const d = makeDeps();
  const states: FeedState[] = [];
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  s.onState((st) => states.push(st));
  await s.ensureConnected();
  expect(d.wsFactory).toHaveBeenCalledWith(
    expect.objectContaining({ jwttoken: 'jwt', feedtype: 'feed', clientcode: 'C1', apikey: 'k' }),
  );
  expect(states).toContain('live');
});

it('ensureConnected is idempotent (single login/socket)', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.ensureConnected();
  expect(d.smartApi.generateSession).toHaveBeenCalledTimes(1);
  expect(d.wsFactory).toHaveBeenCalledTimes(1);
});

it('tracks active token count across subscribe/unsubscribe', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.subscribe([{ token: '111', exchange: 'NSE' }, { token: '222', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(2);
  await s.unsubscribe([{ token: '111', exchange: 'NSE' }]);
  expect(s.activeTokenCount()).toBe(1);
  expect(d.ws.fetchData).toHaveBeenCalled(); // subscribe issued a fetchData
});

it('reconnect emits reconnecting → live with NO intervening connecting', async () => {
  jest.useFakeTimers();
  try {
    const d = makeDeps();
    const states: FeedState[] = [];
    const s = new UserFeedSession('u1', {
      withDecryptedCreds: d.withCreds,
      smartApiFactory: () => d.smartApi as any,
      wsFactory: d.wsFactory as any,
    });
    s.onState((st) => states.push(st));
    await s.ensureConnected(); // first connect: connecting → live

    // Socket drops → onSocketDown('reconnecting') + schedules a reconnect.
    d.ws.handlers['close']();
    // Advance past the first backoff (1000ms) so the reconnect timer fires and
    // the shared-promise re-login runs to completion.
    await jest.advanceTimersByTimeAsync(1000);

    const recIdx = states.indexOf('reconnecting');
    expect(recIdx).toBeGreaterThanOrEqual(0);
    const liveAfterRec = states.indexOf('live', recIdx + 1);
    expect(liveAfterRec).toBeGreaterThan(recIdx);
    // Crucially: no 'connecting' between reconnecting and the following live,
    // otherwise the client's reconnecting → live gap-fill never fires.
    expect(states.slice(recIdx, liveAfterRec + 1)).not.toContain('connecting');
    // Shared-promise routing means exactly one re-login for the reconnect.
    expect(d.smartApi.generateSession).toHaveBeenCalledTimes(2); // initial + reconnect
  } finally {
    jest.useRealTimers();
  }
});

it('dispose closes the socket and logs out', async () => {
  const d = makeDeps();
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  await s.ensureConnected();
  await s.dispose();
  expect(d.ws.close).toHaveBeenCalled();
  expect(d.smartApi.logout).toHaveBeenCalled();
});
