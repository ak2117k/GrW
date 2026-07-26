import { UserFeedSession } from './user-feed-session';
import type { FeedState } from './user-feed.types';

function makeDeps() {
  const ws = {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    fetchData: jest.fn(),
    on: jest.fn(),
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
