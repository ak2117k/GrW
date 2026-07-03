import { Logger } from '@nestjs/common';
import {
  PerUserBrokerSessionFactory,
  AngelOneCreds,
  UserBrokerSession,
  UserSmartApiLike,
} from '../../src/modules/auto-execution/services/per-user-broker-session.factory';
import { OrderRequest } from '../../src/common/interfaces/broker-adapter.interface';
import { generateTOTP } from '../../src/modules/market-data/utils/angel-one-totp';

/**
 * Distinctive secret values so the "never logs creds" assertions can grep the
 * full log stream for any leak. `totpSecret` is a valid base32 string so the
 * shared TOTP generator produces a real 6-digit code.
 */
const creds: AngelOneCreds = {
  apiKey: 'API_KEY_PUB',
  apiSecret: 'SECRET_API_VALUE',
  clientId: 'C1',
  password: 'SUPER_SECRET_PW',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const order: OrderRequest = {
  symbol: 'NIFTY24JUL24000CE',
  token: '12345',
  exchange: 'NFO',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: 50,
  price: 120.5,
  positionType: 'INTRADAY',
};

/** A fake SmartAPI client recording every call. `generateSession` yields a jwt by default. */
function makeFakeClient(overrides: Partial<UserSmartApiLike> = {}) {
  return {
    generateSession: jest
      .fn()
      .mockResolvedValue({ data: { jwtToken: 'jwt', feedToken: 'feed', refreshToken: 'refresh', name: 'Trader' } }),
    placeOrder: jest.fn().mockResolvedValue({ data: { orderid: 'ORD-1' }, message: 'ok' }),
    logout: jest.fn().mockResolvedValue({ status: true }),
    ...overrides,
  };
}

describe('PerUserBrokerSessionFactory.withSession (ephemeral per-user broker session)', () => {
  it('builds a FRESH session via a per-user generateSession and returns the callback value', async () => {
    const client = makeFakeClient();
    const factorySpy = jest.fn(() => client);
    const factory = new PerUserBrokerSessionFactory(factorySpy as any);

    const result = await factory.withSession(creds, async () => 'RESULT');

    expect(result).toBe('RESULT');
    // One fresh SmartAPI client built from THIS user's api key.
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith(creds.apiKey);
    // Exactly one ephemeral login.
    expect(client.generateSession).toHaveBeenCalledTimes(1);
  });

  it('logs in with a fresh TOTP computed from the shared RFC-6238 util', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    await factory.withSession(creds, async () => 0);

    const [clientId, password, totp] = client.generateSession.mock.calls[0];
    expect(clientId).toBe(creds.clientId);
    expect(password).toBe(creds.password);
    expect(totp).toBe(generateTOTP(creds.totpSecret));
  });

  it('passes a UserBrokerSession exposing placeOrder to the callback', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    let seen: UserBrokerSession | undefined;
    await factory.withSession(creds, async (session) => {
      seen = session;
      expect(typeof session.placeOrder).toBe('function');
    });

    expect(seen).toBeDefined();
  });

  it('logs in BEFORE placing the order (session is authenticated first)', async () => {
    const order$: string[] = [];
    const client = makeFakeClient({
      generateSession: jest.fn().mockImplementation(async () => {
        order$.push('login');
        return { data: { jwtToken: 'jwt' } };
      }),
      placeOrder: jest.fn().mockImplementation(async () => {
        order$.push('place');
        return { data: { orderid: 'ORD-1' } };
      }),
    });
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    await factory.withSession(creds, async (session) => session.placeOrder(order));

    expect(order$).toEqual(['login', 'place']);
  });

  it('maps OrderRequest to Angel One SmartAPI params and returns a PLACED response', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    const resp = await factory.withSession(creds, async (session) => session.placeOrder(order));

    expect(resp).toEqual({ orderId: 'ORD-1', status: 'PLACED', message: 'ok' });
    const params = client.placeOrder.mock.calls[0][0];
    expect(params).toMatchObject({
      variety: 'NORMAL',
      tradingsymbol: order.symbol,
      symboltoken: order.token,
      transactiontype: 'BUY',
      exchange: 'NFO',
      ordertype: 'LIMIT',
      producttype: 'INTRADAY',
      duration: 'DAY',
      quantity: '50',
      price: '120.5',
      triggerprice: '0',
    });
  });

  it('forwards an idempotency order tag as SmartAPI ordertag when provided', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    await factory.withSession(creds, async (session) =>
      session.placeOrder(order, 'idem-key-abc'),
    );

    expect(client.placeOrder.mock.calls[0][0].ordertag).toBe('idem-key-abc');
  });

  it('returns a REJECTED response when the broker returns no orderid', async () => {
    const client = makeFakeClient({
      placeOrder: jest.fn().mockResolvedValue({ message: 'RMS blocked' }),
    });
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    const resp = await factory.withSession(creds, async (session) => session.placeOrder(order));
    expect(resp.status).toBe('REJECTED');
    expect(resp.orderId).toBe('');
    expect(resp.message).toBe('RMS blocked');
  });

  it('returns a FAILED response (does not throw) when placeOrder rejects', async () => {
    const client = makeFakeClient({
      placeOrder: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    const resp = await factory.withSession(creds, async (session) => session.placeOrder(order));
    expect(resp.status).toBe('FAILED');
    expect(resp.message).toContain('socket hang up');
  });

  it('DISPOSES the session after the callback returns (use-after-dispose throws)', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    let captured: UserBrokerSession | undefined;
    await factory.withSession(creds, async (session) => {
      captured = session;
      return 'ok';
    });

    await expect(captured!.placeOrder(order)).rejects.toThrow(/dispos/i);
  });

  it('best-effort logs the session out on disposal to release the broker session', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    await factory.withSession(creds, async () => 'ok');

    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledWith(creds.clientId);
  });

  it('disposes even when the callback throws, and propagates the error', async () => {
    const client = makeFakeClient();
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    let captured: UserBrokerSession | undefined;
    await expect(
      factory.withSession(creds, async (session) => {
        captured = session;
        throw new Error('pipeline boom');
      }),
    ).rejects.toThrow('pipeline boom');

    // Session was disposed + logged out despite the callback throwing.
    expect(client.logout).toHaveBeenCalledTimes(1);
    await expect(captured!.placeOrder(order)).rejects.toThrow(/dispos/i);
  });

  it('does not fail the callback when best-effort logout throws', async () => {
    const client = makeFakeClient({
      logout: jest.fn().mockRejectedValue(new Error('logout 500')),
    });
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    await expect(factory.withSession(creds, async () => 'ok')).resolves.toBe('ok');
  });

  it('throws a GENERIC error (no cred leak) when the ephemeral login yields no jwt', async () => {
    const client = makeFakeClient({
      generateSession: jest.fn().mockResolvedValue({ message: 'invalid password AB1234' }),
    });
    const factory = new PerUserBrokerSessionFactory((() => client) as any);

    let err: Error | undefined;
    await factory.withSession(creds, async () => 'ok').catch((e) => (err = e));

    expect(err).toBeDefined();
    expect(err!.message).not.toContain('invalid password');
    expect(err!.message).not.toContain(creds.password);
    expect(err!.message).not.toContain(creds.totpSecret);
  });

  it('NEVER logs plaintext creds (password / totpSecret / apiSecret) anywhere', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    };
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'verbose').mockImplementation(capture),
    ];

    try {
      // Exercise the happy path AND a broker error path (which logs).
      const okClient = makeFakeClient();
      await new PerUserBrokerSessionFactory((() => okClient) as any).withSession(
        creds,
        async (s) => s.placeOrder(order, 'idem-tag'),
      );

      const errClient = makeFakeClient({
        placeOrder: jest.fn().mockRejectedValue(new Error('boom')),
      });
      await new PerUserBrokerSessionFactory((() => errClient) as any).withSession(
        creds,
        async (s) => s.placeOrder(order),
      );

      const all = logged.join('\n');
      expect(all).not.toContain(creds.password);
      expect(all).not.toContain(creds.totpSecret);
      expect(all).not.toContain(creds.apiSecret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
