/**
 * Safety batch 2, item 3: a user's book is read only through a session
 * authenticated with THAT user's own Angel credentials.
 *
 * AngelOneAuthService (the shared market-data feed) resolves its credentials
 * ENV-FIRST (FeedCredentialProvider), so its session can belong to a different
 * Angel account than the user's vault credentials, even for the user flagged
 * isFeedAccount. Tier order: warm per-user feed session (no login) → the shared
 * feed session only when its client code equals the user's vault client code →
 * an ephemeral login with the user's own credentials. Never a second login over
 * a live feed of the same account.
 */
import { PerUserBrokerSessionFactory, type UserSmartApiLike } from './per-user-broker-session.factory';
import { OwnSessionUnavailableError, withOwnAccountSession } from './own-account-session';

const USER_CREDS = { apiKey: 'UK', apiSecret: 'US', clientId: 'U123', password: 'PW', totpSecret: 'JBSWY3DPEHPK3PXP' };

function client(tag: string): UserSmartApiLike & { tag: string } {
  return {
    tag,
    generateSession: jest.fn(async () => ({ data: { jwtToken: 'jwt' } })),
    placeOrder: jest.fn(),
    logout: jest.fn(async () => ({})),
    getRMS: jest.fn(),
    getProfile: jest.fn(),
    getPosition: jest.fn(async () => ({ status: true, data: [{ owner: tag }] })),
    getAllHolding: jest.fn(),
    getTradeBook: jest.fn(),
    getOrderBook: jest.fn(),
  };
}

function setup(opts: {
  warm?: boolean;
  hasSession?: boolean;
  sharedAuthenticated?: boolean;
  sharedClientId?: string;
}) {
  const ephemeral = client('ephemeral');
  const factory = new PerUserBrokerSessionFactory(() => ephemeral);
  const warmClient = client('user-feed');
  const release = jest.fn();
  const userFeeds = {
    leaseRestClient: jest.fn(() => (opts.warm ? { client: warmClient, clientId: 'U123', release } : null)),
    hasSession: jest.fn(() => !!opts.hasSession || !!opts.warm),
  };
  const shared = client('shared-feed');
  const authService = {
    isAuthenticated: jest.fn(() => !!opts.sharedAuthenticated),
    getSmartApi: jest.fn(() => shared),
    getClientId: jest.fn(() => opts.sharedClientId ?? ''),
  };
  const decryptor = {
    withDecryptedCredentials: jest.fn(async (_u: string, _c: unknown, use: (c: typeof USER_CREDS) => Promise<unknown>) => use({ ...USER_CREDS })),
  };
  const deps = { userFeeds, factory, decryptor: decryptor as never, authService };
  const read = () =>
    withOwnAccountSession(deps, 'user-1', { reason: 'REVALIDATE' }, async (s, source) => ({
      source,
      book: await s.getPositionsEnvelope(),
    }));
  return { read, ephemeral, warmClient, shared, release, decryptor, authService, userFeeds };
}

describe('withOwnAccountSession', () => {
  it('uses the warm per-user feed session without any login, decrypt or logout, and releases the lease', async () => {
    const h = setup({ warm: true, sharedAuthenticated: true, sharedClientId: 'U123' });
    const r = await h.read();
    expect(r).toEqual({ source: 'user-feed', book: { status: true, data: [{ owner: 'user-feed' }] } });
    expect(h.warmClient.generateSession).not.toHaveBeenCalled();
    expect(h.warmClient.logout).not.toHaveBeenCalled();
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
    expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(h.shared.getPosition).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('refuses (no login) while the per-user feed session is between logins', async () => {
    const h = setup({ hasSession: true });
    await expect(h.read()).rejects.toBeInstanceOf(OwnSessionUnavailableError);
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
    expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
  });

  it('env creds of ANOTHER client code ⇒ the shared feed session is NOT used for this user; an ephemeral login on the user\'s own account is', async () => {
    const h = setup({ sharedAuthenticated: true, sharedClientId: 'ENV999' });
    const r = await h.read();
    expect(r.source).toBe('ephemeral');
    expect(r.book).toEqual({ status: true, data: [{ owner: 'ephemeral' }] });
    expect(h.shared.getPosition).not.toHaveBeenCalled();
    expect(h.authService.getSmartApi).not.toHaveBeenCalled();
    expect(h.ephemeral.generateSession).toHaveBeenCalledWith('U123', 'PW', expect.any(String));
    expect(h.ephemeral.logout).toHaveBeenCalledWith('U123');
  });

  it('shared feed session whose client code equals the user\'s vault client code is borrowed (no second login)', async () => {
    const h = setup({ sharedAuthenticated: true, sharedClientId: ' u123 ' });
    const r = await h.read();
    expect(r).toEqual({ source: 'shared-feed', book: { status: true, data: [{ owner: 'shared-feed' }] } });
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
    expect(h.shared.generateSession).not.toHaveBeenCalled();
    expect(h.shared.logout).not.toHaveBeenCalled();
  });

  it('same client code but the shared feed is between logins ⇒ refuses rather than log in over it', async () => {
    const h = setup({ sharedAuthenticated: false, sharedClientId: 'U123' });
    await expect(h.read()).rejects.toBeInstanceOf(OwnSessionUnavailableError);
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
  });

  it('no feed sessions at all ⇒ one ephemeral login with the user\'s own credentials', async () => {
    const h = setup({});
    const r = await h.read();
    expect(r.source).toBe('ephemeral');
    expect(h.ephemeral.generateSession).toHaveBeenCalledTimes(1);
  });
});
