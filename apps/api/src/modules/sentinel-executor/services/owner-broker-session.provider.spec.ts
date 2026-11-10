import { OwnerBrokerSessionProvider, FeedSessionNotReadyError, NoFeedSessionError } from './owner-broker-session.provider';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { UserFeedSession } from '../../market-data/services/user-feed-session';

function deps(warm: unknown, hasSession = warm != null) {
  const session = { placeOrder: jest.fn() };
  const userFeeds = {
    leaseRestClient: jest.fn(() => (warm ? { ...(warm as object), release: jest.fn() } : null)),
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
    expect(d.factory.borrow).toHaveBeenCalledWith({ tag: 'warm' }, 'C1', expect.any(Function), { priority: null });
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(d.factory.withSession).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral ORDER-reason vault login only when no feed session exists', async () => {
    const d = deps(null, false);
    const seen: string[] = [];
    await d.p.withOwnerSession('owner', async (_s, source) => {
      seen.push(source);
    }, { allowEphemeralLogin: true });
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
    expect(st.mgr.warmRestClient('owner')).toEqual({ client: st.sdk, clientId: 'C1', priority: expect.any(Object) }); // still lendable
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
    await expect(st.provider.withOwnerSession('owner', jest.fn(), { allowEphemeralLogin: true })).rejects.toThrow('vault stub');
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

describe('dry-run never logs in (review fix 3)', () => {
  it('no feed session + login not allowed → NoFeedSessionError; no decrypt, no login, callback never runs', async () => {
    const d = deps(null, false);
    const fn = jest.fn();
    await expect(d.p.withOwnerSession('owner', fn, { allowEphemeralLogin: false })).rejects.toBeInstanceOf(NoFeedSessionError);
    expect(fn).not.toHaveBeenCalled();
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(d.factory.withSession).not.toHaveBeenCalled();
  });

  it('the default is NO login (fail-safe): a caller must opt in to the ephemeral tier', async () => {
    const d = deps(null, false);
    await expect(d.p.withOwnerSession('owner', jest.fn())).rejects.toBeInstanceOf(NoFeedSessionError);
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
  });

  it('a warm feed session is still borrowed when login is not allowed', async () => {
    const d = deps({ client: {}, clientId: 'C1' });
    await d.p.withOwnerSession('owner', async (_s, source) => expect(source).toBe('user-feed'), { allowEphemeralLogin: false });
    expect(d.factory.borrow).toHaveBeenCalledTimes(1);
  });
});

describe('the borrowed feed session is leased for the whole callback (cannot be disposed mid-order)', () => {
  function leased() {
    const d = deps({ client: { tag: 'warm' }, clientId: 'C1' });
    const release = jest.fn();
    (d.userFeeds as any).leaseRestClient = jest.fn(() => ({ client: { tag: 'warm' }, clientId: 'C1', release }));
    return { ...d, release };
  }

  it('leases, borrows the leased client, and releases after the callback', async () => {
    const d = leased();
    const order: string[] = [];
    d.release.mockImplementation(() => order.push('release'));
    await d.p.withOwnerSession('owner', async () => { order.push('fn'); });
    expect((d.userFeeds as any).leaseRestClient).toHaveBeenCalledWith('owner');
    expect(d.factory.borrow).toHaveBeenCalledWith({ tag: 'warm' }, 'C1', expect.any(Function), { priority: null });
    expect(order).toEqual(['fn', 'release']);
  });

  it('releases even when the callback throws', async () => {
    const d = leased();
    await expect(d.p.withOwnerSession('owner', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(d.release).toHaveBeenCalledTimes(1);
  });
});

describe('lease end to end (real manager + feed session, fake SDK)', () => {
  it('the hub unpinning mid-order cannot tear the feed down under the order; it idles out only after', async () => {
    jest.useFakeTimers();
    try {
      const ws = { connect: jest.fn().mockResolvedValue(undefined), close: jest.fn(), fetchData: jest.fn(), on: jest.fn() };
      const sdk = {
        generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt', feedToken: 'feed' } }),
        logout: jest.fn().mockResolvedValue({}),
        placeOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', data: { orderid: 'O9' } }),
        getPosition: jest.fn().mockResolvedValue({ status: true, data: [] }),
        getOrderBook: jest.fn().mockResolvedValue({ status: true, data: [] }),
      };
      const mgr = new UserFeedManager(
        (userId: string) => new UserFeedSession(userId, {
          withDecryptedCreds: (async (_u: string, cb: any) => cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' })) as any,
          smartApiFactory: () => sdk as any,
          wsFactory: () => ws,
        }),
        { idleMs: 1000, maxSessions: 40 },
      );
      const provider = new OwnerBrokerSessionProvider(mgr, new PerUserBrokerSessionFactory(), { withDecryptedCredentials: jest.fn() } as never);
      const T = [{ token: '1', exchange: 'NFO' }];
      await mgr.pin('owner', T);

      await provider.withOwnerSession('owner', async (s) => {
        await mgr.unpin('owner', T); // the hub lets go mid-order
        await jest.advanceTimersByTimeAsync(5000);
        expect(mgr.hasSession('owner')).toBe(true);
        await s.getOrderBookEnvelope(); // still usable
      });
      expect(mgr.hasSession('owner')).toBe(true);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mgr.hasSession('owner')).toBe(false); // lease released: normal idle teardown resumes
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('orders get priority (2026-11-10: a lost MARKET SELL answer blocked a position for 4 h)', () => {
  function stack() {
    const ws = { connect: jest.fn().mockResolvedValue(undefined), close: jest.fn(), fetchData: jest.fn(), on: jest.fn() };
    const data = {
      generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt', feedToken: 'feed', refreshToken: 'rt' } }),
      logout: jest.fn().mockResolvedValue({}),
      getCandleData: jest.fn(),
      marketData: jest.fn().mockResolvedValue({ status: true, data: { fetched: [] } }),
      optionGreek: jest.fn(),
      placeOrder: jest.fn(),
      getPosition: jest.fn(),
      getOrderBook: jest.fn(),
    };
    let answer!: (v: unknown) => void;
    const orders = {
      generateSession: jest.fn(),
      logout: jest.fn(),
      placeOrder: jest.fn(() => new Promise((r) => { answer = r; })),
      getPosition: jest.fn().mockResolvedValue({ status: true, data: [] }),
      getOrderBook: jest.fn().mockResolvedValue({ status: true, data: [] }),
    };
    const orderFactory = jest.fn(() => orders);
    const mgr = new UserFeedManager(
      (userId: string) => new UserFeedSession(userId, {
        withDecryptedCreds: (async (_u: string, cb: any) => cb({ apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'AAAA' })) as any,
        smartApiFactory: () => data as any,
        orderSmartApiFactory: orderFactory,
        wsFactory: () => ws,
      }),
      { idleMs: 120000, maxSessions: 40 },
    );
    const provider = new OwnerBrokerSessionProvider(mgr, new PerUserBrokerSessionFactory(), { withDecryptedCredentials: jest.fn() } as never);
    return { mgr, data, orders, orderFactory, provider, answer: (v: unknown) => answer(v) };
  }
  const ORDER = { symbol: 'X', token: '1', exchange: 'MCX', side: 'SELL', orderType: 'MARKET', quantity: 30, positionType: 'CARRYFORWARD' } as never;

  it('the exit places and reads on the ORDER client, built from the live login\'s tokens — never a second login', async () => {
    const st = stack();
    await st.mgr.pin('owner', [{ token: '1', exchange: 'MCX' }]);
    expect(st.orderFactory).toHaveBeenCalledWith('k', { accessToken: 'jwt', refreshToken: 'rt', clientCode: 'C1' });
    const p = st.provider.withOwnerSession('owner', async (s) => {
      await s.getOrderBookEnvelope();
      return s.placeOrderClassified(ORDER, 'atMabc');
    });
    await new Promise((r) => setImmediate(r));
    st.answer({ status: true, message: 'SUCCESS', data: { orderid: 'O1' } });
    await expect(p).resolves.toMatchObject({ status: 'PLACED', orderId: 'O1' });
    expect(st.orders.placeOrder).toHaveBeenCalledTimes(1);
    expect(st.orders.getOrderBook).toHaveBeenCalledTimes(1);
    expect(st.data.placeOrder).not.toHaveBeenCalled();
    expect(st.data.getOrderBook).not.toHaveBeenCalled();
    expect(st.orders.generateSession).not.toHaveBeenCalled();
    expect(st.data.generateSession).toHaveBeenCalledTimes(1); // only the feed's own login
    expect(st.orders.logout).not.toHaveBeenCalled();
    expect(st.data.logout).not.toHaveBeenCalled();
  });

  it('while the order call is in flight the user\'s quote polls wait, then go', async () => {
    const st = stack();
    await st.mgr.pin('owner', [{ token: '1', exchange: 'MCX' }]);
    const p = st.provider.withOwnerSession('owner', (s) => s.placeOrderClassified(ORDER, 'atMabc'));
    await new Promise((r) => setImmediate(r));
    const session = (st.mgr as any).registry.get('owner').session as UserFeedSession;
    const q = session.getQuotes([{ token: '1', exchange: 'MCX' }]);
    await new Promise((r) => setImmediate(r));
    expect(st.data.marketData).not.toHaveBeenCalled(); // held back behind the order
    st.answer({ status: true, message: 'SUCCESS', data: { orderid: 'O1' } });
    await p;
    await q;
    expect(st.data.marketData).toHaveBeenCalledTimes(1);
  });

  it('a session whose order-client factory fails still serves orders on the data client', async () => {
    const st = stack();
    st.orderFactory.mockImplementation(() => { throw new Error('boom'); });
    await st.mgr.pin('owner', [{ token: '1', exchange: 'MCX' }]);
    st.data.placeOrder.mockResolvedValue({ status: true, message: 'SUCCESS', data: { orderid: 'O2' } });
    await expect(st.provider.withOwnerSession('owner', (s) => s.placeOrderClassified(ORDER, 'atMabc'))).resolves.toMatchObject({ orderId: 'O2' });
    expect(st.data.generateSession).toHaveBeenCalledTimes(1);
  });
});
