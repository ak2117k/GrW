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

  describe('onModuleInit', () => {
    it('skips auto-login (no crash) when no feed credentials are configured', async () => {
      const provider = makeProvider({ hasFeedCredentials: jest.fn().mockResolvedValue(false) });
      service = new AngelOneAuthService(provider);

      await service.onModuleInit();

      expect(provider.hasFeedCredentials).toHaveBeenCalledTimes(1);
      expect(provider.withFeedCredentials).not.toHaveBeenCalled();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('does NOT crash boot when feed-credential resolution throws (e.g. isFeedAccount column not yet migrated)', async () => {
      const boom = new Error('column "isFeedAccount" does not exist');
      const provider = makeProvider({ hasFeedCredentials: jest.fn().mockRejectedValue(boom) });
      service = new AngelOneAuthService(provider);

      // onModuleInit must resolve (never reject) so a missing migration / DB
      // hiccup can't abort NestJS bootstrap and take the whole API down.
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.isAuthenticated()).toBe(false);
    });

    it('logs in when feed credentials are available', async () => {
      const provider = makeProvider();
      service = new AngelOneAuthService(provider);

      await service.onModuleInit();

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
