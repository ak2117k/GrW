import { AngelOneAuthService } from './angel-one-auth.service';
import type { FeedCredentialProvider } from './feed-credential-provider';
import type { AngelOneCreds } from '../../auto-execution/services/per-user-broker-session.factory';

// Mock the SmartAPI client so login() never makes a real broker call. Each
// `new SmartAPI()` returns a fresh fake whose generateSession succeeds.
const generateSession = jest.fn();
const smartApiLogout = jest.fn().mockResolvedValue({});
jest.mock('smartapi-javascript', () => ({
  SmartAPI: jest.fn().mockImplementation(() => ({
    generateSession,
    generateToken: jest.fn(),
    logout: smartApiLogout,
  })),
}));

// A syntactically valid base32 secret so the real generateTOTP util produces a
// code without throwing.
const FEED_CREDS: AngelOneCreds = {
  apiKey: 'feed-api-key',
  apiSecret: 'feed-api-secret',
  clientId: 'C12345',
  password: 'super-secret-pw',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

function makeProvider(
  overrides: Partial<jest.Mocked<Pick<FeedCredentialProvider, 'hasFeedCredentials' | 'withFeedCredentials'>>> = {},
): jest.Mocked<FeedCredentialProvider> {
  return {
    hasFeedCredentials: jest.fn().mockResolvedValue(true),
    // Default: run the caller's `use` with the feed creds (the vault lease).
    withFeedCredentials: jest.fn((use: (c: AngelOneCreds) => Promise<unknown>) => use(FEED_CREDS)),
    ...overrides,
  } as unknown as jest.Mocked<FeedCredentialProvider>;
}

describe('AngelOneAuthService (vault->market-feed bridge)', () => {
  let service: AngelOneAuthService;

  beforeEach(() => {
    generateSession.mockReset().mockResolvedValue({
      data: { jwtToken: 'jwt-123', refreshToken: 'refresh-123', feedToken: 'feed-123' },
    });
    smartApiLogout.mockClear();
  });

  afterEach(() => {
    // Clear the ~23h refresh timer login() schedules so no handle leaks.
    service?.onModuleDestroy();
  });

  /**
   * `onModuleInit` no longer awaits the login — it must not, or it gates the
   * port bind. So these tests start the hook and then drain the microtask queue
   * to observe the work it detached.
   */
  const flushDetachedBootWork = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  describe('onModuleInit', () => {
    it('skips auto-login (no crash) when no feed credentials are configured', async () => {
      const provider = makeProvider({ hasFeedCredentials: jest.fn().mockResolvedValue(false) });
      service = new AngelOneAuthService(provider);

      service.onModuleInit();
      await flushDetachedBootWork();

      expect(provider.hasFeedCredentials).toHaveBeenCalledTimes(1);
      expect(provider.withFeedCredentials).not.toHaveBeenCalled();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('does NOT crash boot when feed-credential resolution throws (e.g. isFeedAccount column not yet migrated)', async () => {
      const boom = new Error('column "isFeedAccount" does not exist');
      const provider = makeProvider({ hasFeedCredentials: jest.fn().mockRejectedValue(boom) });
      service = new AngelOneAuthService(provider);

      // onModuleInit must never throw, and the detached login must never reject
      // unhandled, so a missing migration / DB hiccup can't abort NestJS
      // bootstrap and take the whole API down.
      expect(() => service.onModuleInit()).not.toThrow();
      await flushDetachedBootWork();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('logs in when feed credentials are available', async () => {
      const provider = makeProvider();
      service = new AngelOneAuthService(provider);

      service.onModuleInit();
      await flushDetachedBootWork();

      expect(provider.withFeedCredentials).toHaveBeenCalledTimes(1);
      expect(service.isAuthenticated()).toBe(true);
      expect(service.getFeedToken()).toBe('feed-123');
    });
  });

  describe('login', () => {
    it('leases credentials and stores only the session (never the raw secrets)', async () => {
      const provider = makeProvider();
      service = new AngelOneAuthService(provider);

      await service.login();

      // Session + non-secret identifiers are retained...
      expect(service.getAuthToken()).toBe('jwt-123');
      expect(service.getFeedToken()).toBe('feed-123');
      expect(service.getApiKey()).toBe('feed-api-key');
      expect(service.getClientId()).toBe('C12345');

      // ...but the raw password / TOTP secret are NEVER held on the instance.
      // Scan only string-valued own properties (avoids JSON.stringify choking on
      // the refresh timer / logger).
      const retainedStrings = Object.values(service as unknown as Record<string, unknown>).filter(
        (v): v is string => typeof v === 'string',
      );
      expect(retainedStrings).not.toContain(FEED_CREDS.password);
      expect(retainedStrings).not.toContain(FEED_CREDS.totpSecret);
      expect((service as unknown as { password?: unknown }).password).toBeUndefined();
      expect((service as unknown as { totpSecret?: unknown }).totpSecret).toBeUndefined();
    });

    it('re-leases credentials on every login (ephemeral, not held between logins)', async () => {
      const provider = makeProvider();
      service = new AngelOneAuthService(provider);

      await service.login();
      await service.login();

      expect(provider.withFeedCredentials).toHaveBeenCalledTimes(2);
    });

    it('passes the leased credentials to generateSession', async () => {
      const provider = makeProvider();
      service = new AngelOneAuthService(provider);

      await service.login();

      expect(generateSession).toHaveBeenCalledWith(
        FEED_CREDS.clientId,
        FEED_CREDS.password,
        expect.any(String), // freshly-computed TOTP
      );
    });
  });
});

/**
 * The broker login is a network round trip — three attempts with 6s of backoff
 * between them, and no timeout on the SmartAPI call itself. Awaited in
 * `onModuleInit` it sat in front of `app.listen()`, because Nest awaits every
 * boot hook before the server binds. A slow or unreachable broker therefore did
 * not degrade the feed; it stopped the API from ever opening a port, and Render
 * failed the deploy with "no open ports detected".
 *
 * Live market data is explicitly non-critical to boot — the catch in this hook
 * already says so, degrading to demo/REST data. So it must not gate the port.
 */
describe('AngelOneAuthService boot hook', () => {
  it('returns without waiting for the broker login, so the port can bind', async () => {
    const provider = {
      hasFeedCredentials: jest.fn().mockResolvedValue(true),
      // A login that never settles — a hung broker call, not a failing one.
      withFeedCredentials: jest.fn().mockReturnValue(new Promise(() => {})),
    } as any;

    const service = new AngelOneAuthService(provider);

    const outcome = await Promise.race([
      Promise.resolve(service.onModuleInit()).then(() => 'hook settled'),
      new Promise((resolve) => {
        setTimeout(() => resolve('hook blocked on the broker'), 100).unref();
      }),
    ]);

    expect(outcome).toBe('hook settled');
  });

  it('still attempts the login, just not in front of the port', async () => {
    const provider = {
      hasFeedCredentials: jest.fn().mockResolvedValue(true),
      withFeedCredentials: jest.fn().mockResolvedValue(undefined),
    } as any;

    new AngelOneAuthService(provider).onModuleInit();
    // Let the detached credential check and login run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(provider.withFeedCredentials).toHaveBeenCalledTimes(1);
  });
});
