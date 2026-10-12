import { OwnerBrokerSessionProvider, FeedSessionNotReadyError } from './owner-broker-session.provider';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { UserFeedSession } from '../../market-data/services/user-feed-session';

function deps(warm: unknown, hasSession = warm != null) {
  const session = { placeOrder: jest.fn() };
  const userFeeds = {
    warmRestClient: jest.fn().mockReturnValue(warm),
    hasSession: jest.fn().mockReturnValue(hasSession),
  };
  const factory = {
    borrow: jest.fn(async (_c: unknown, _id: string, fn: any) => fn(session)),
    withSession: jest.fn(async (_creds: unknown, fn: any) => fn(session)),
  };
  const decryptor = {
    withDecryptedCredentials: jest.fn(async (_u: string, _ctx: unknown, use: any) => use({ clientId: 'C1' })),
  };
  const p = new OwnerBrokerSessionProvider(userFeeds as never, factory as never, decryptor as never);
  return { p, session, userFeeds, factory, decryptor };
}

describe('OwnerBrokerSessionProvider (ruling R1)', () => {
  it('prefers the warm per-user session: borrow, no decrypt, no login', async () => {
    const d = deps({ client: { tag: 'warm' }, clientId: 'C1' });
    const seen: string[] = [];
    await d.p.withOwnerSession('owner', async (_s, source) => {
      seen.push(source);
    });
    expect(seen).toEqual(['user-feed']);
    expect(d.factory.borrow).toHaveBeenCalledWith({ tag: 'warm' }, 'C1', expect.any(Function));
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(d.factory.withSession).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral ORDER-reason vault login only when no feed session exists', async () => {
    const d = deps(null, false);
    const seen: string[] = [];
    await d.p.withOwnerSession('owner', async (_s, source) => {
      seen.push(source);
    });
    expect(seen).toEqual(['ephemeral']);
    expect(d.decryptor.withDecryptedCredentials).toHaveBeenCalledWith('owner', { reason: 'ORDER' }, expect.any(Function));
    expect(d.factory.withSession).toHaveBeenCalledTimes(1);
    expect(d.factory.borrow).not.toHaveBeenCalled();
  });

  it('refuses (no login at all) when a feed session exists but is not REST-ready (mid re-login)', async () => {
    const d = deps(null, true);
    const fn = jest.fn();
    await expect(d.p.withOwnerSession('owner', fn)).rejects.toBeInstanceOf(FeedSessionNotReadyError);
    expect(fn).not.toHaveBeenCalled();
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(d.factory.withSession).not.toHaveBeenCalled();
    expect(d.factory.borrow).not.toHaveBeenCalled();
  });

  it('an error inside the warm tier is NOT retried on the ephemeral tier (no double placement)', async () => {
    const d = deps({ client: {}, clientId: 'C1' });
    await expect(
      d.p.withOwnerSession('owner', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(d.factory.withSession).not.toHaveBeenCalled();
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
  });
});

describe('borrowing the live owner feed session end to end (real manager + session + factory, fake SDK)', () => {
  function liveStack() {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const ws = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      fetchData: jest.fn(),
      on: jest.fn((e: string, cb: any) => {
        handlers[e] = cb;
      }),
    };
    const sdk = {
      generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt', feedToken: 'feed' } }),
      logout: jest.fn().mockResolvedValue({}),
      getCandleData: jest.fn(),
      marketData: jest.fn(),
      optionGreek: jest.fn(),
      placeOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', data: { orderid: 'O9' } }),
      getPosition: jest.fn().mockResolvedValue({ status: true, data: [] }),
      getOrderBook: jest.fn().mockResolvedValue({ status: true, data: [] }),
    };
    const feedLease = jest.fn(async (_u: string, cb: any) =>
      cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' }),
    );
    const sessionFactory = jest.fn(
      (userId: string) =>
        new UserFeedSession(userId, {
          withDecryptedCreds: feedLease as any,
          smartApiFactory: () => sdk as any,
          wsFactory: () => ws,
        }),
    );
    const mgr = new UserFeedManager(sessionFactory, { idleMs: 120000, maxSessions: 40 });
    const orderFactory = new PerUserBrokerSessionFactory(() => {
      throw new Error('must not build a second SmartAPI client');
    });
    const vault = { withDecryptedCredentials: jest.fn() };
    const provider = new OwnerBrokerSessionProvider(mgr, orderFactory, vault as never);
    return { mgr, sdk, ws, handlers, feedLease, sessionFactory, vault, provider };
  }

  it('places through the feed client: zero extra logins, no logout, feed stays live and lendable', async () => {
    const st = liveStack();
    const states: string[] = [];
    st.mgr.addStateListener((_u, s) => states.push(s));
    await st.mgr.pin('owner', [{ token: '1', exchange: 'NFO' }]); // the hub's pin = the live feed
    expect(st.sdk.generateSession).toHaveBeenCalledTimes(1);
    states.length = 0;

    const r = await st.provider.withOwnerSession('owner', async (s, source) => {
      expect(source).toBe('user-feed');
      await s.getPositionsEnvelope();
      await s.getOrderBookEnvelope();
      return s.placeOrder(
        { symbol: 'X', token: '1', exchange: 'NFO', side: 'SELL', orderType: 'MARKET', quantity: 75, positionType: 'CARRYFORWARD' },
        'axMabc',
      );
    });

    expect(r).toEqual({ orderId: 'O9', status: 'PLACED', message: 'SUCCESS' });
    expect(st.sdk.placeOrder).toHaveBeenCalledTimes(1);
    expect(st.sdk.generateSession).toHaveBeenCalledTimes(1); // still only the feed's own login
    expect(st.sdk.logout).not.toHaveBeenCalled();
    expect(st.ws.close).not.toHaveBeenCalled();
    expect(st.feedLease).toHaveBeenCalledTimes(1);
    expect(st.vault.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(st.sessionFactory).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]); // no feed state transition at all
    expect(st.mgr.warmRestClient('owner')).toEqual({ client: st.sdk, clientId: 'C1' }); // still lendable
  });

  it('a throwing callback on the borrowed session still never logs the feed out', async () => {
    const st = liveStack();
    await st.mgr.pin('owner', [{ token: '1', exchange: 'NFO' }]);
    await expect(
      st.provider.withOwnerSession('owner', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(st.sdk.logout).not.toHaveBeenCalled();
    expect(st.ws.close).not.toHaveBeenCalled();
    expect(st.sdk.generateSession).toHaveBeenCalledTimes(1);
    expect(st.vault.withDecryptedCredentials).not.toHaveBeenCalled();
  });

  it('with no feed session at all, the provider never creates one (falls to the vault tier)', async () => {
    const st = liveStack();
    st.vault.withDecryptedCredentials.mockRejectedValue(new Error('vault stub'));
    await expect(st.provider.withOwnerSession('owner', jest.fn())).rejects.toThrow('vault stub');
    expect(st.sessionFactory).not.toHaveBeenCalled();
    expect(st.vault.withDecryptedCredentials).toHaveBeenCalledWith('owner', { reason: 'ORDER' }, expect.any(Function));
  });

  it('while the feed is re-logging in after a drop, the provider refuses rather than logging in a second time', async () => {
    jest.useFakeTimers();
    try {
      const st = liveStack();
      await st.mgr.pin('owner', [{ token: '1', exchange: 'NFO' }]);
      st.sdk.generateSession.mockResolvedValue({ data: {} }); // the feed's re-login fails
      st.handlers['close']();
      await jest.advanceTimersByTimeAsync(1000);
      const fn = jest.fn();
      await expect(st.provider.withOwnerSession('owner', fn)).rejects.toBeInstanceOf(FeedSessionNotReadyError);
      expect(fn).not.toHaveBeenCalled();
      expect(st.vault.withDecryptedCredentials).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
