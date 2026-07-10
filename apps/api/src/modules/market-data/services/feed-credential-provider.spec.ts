import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CredentialDecryptor } from '../../credential-vault/execution/credential-decryptor';
import { AngelOneCreds } from '../../auto-execution/services/per-user-broker-session.factory';
import { FeedCredentialProvider, NoFeedCredentialsError } from './feed-credential-provider';

/**
 * Unit tests for FeedCredentialProvider — the env→vault→none resolver for the
 * single account that powers the shared market feed (spec §3.1). ConfigService,
 * PrismaService and the CredentialDecryptor are all faked; no real broker/KMS/DB.
 */
describe('FeedCredentialProvider', () => {
  /** A ConfigService fake backed by a plain env map with per-key defaults. */
  function fakeConfig(env: Record<string, string | undefined>): ConfigService {
    return {
      get: <T>(key: string, defaultValue?: T): T => {
        const v = env[key];
        return (v === undefined ? defaultValue : v) as T;
      },
    } as unknown as ConfigService;
  }

  /** A PrismaService fake exposing only `user.findFirst`. */
  function fakePrisma(findFirst: jest.Mock): PrismaService {
    return { user: { findFirst } } as unknown as PrismaService;
  }

  /** A CredentialDecryptor fake whose `withDecryptedCredentials` we can spy on. */
  function fakeDecryptor(withDecryptedCredentials: jest.Mock): CredentialDecryptor {
    return { withDecryptedCredentials } as unknown as CredentialDecryptor;
  }

  const FULL_ENV = {
    ANGEL_ONE_API_KEY: 'live_api_key',
    ANGEL_ONE_API_SECRET: 'live_api_secret',
    ANGEL_ONE_CLIENT_ID: 'C12345',
    ANGEL_ONE_PASSWORD: 'live_password',
    ANGEL_ONE_TOTP_SECRET: 'live_totp_secret',
  };

  // ─── env path ─────────────────────────────────────────────────────────
  it('uses env creds directly and never touches the vault', async () => {
    const findFirst = jest.fn();
    const withDecrypted = jest.fn();
    const provider = new FeedCredentialProvider(
      fakeConfig(FULL_ENV),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    const captured = await provider.withFeedCredentials(async (creds) => creds);

    expect(captured).toEqual<AngelOneCreds>({
      apiKey: 'live_api_key',
      apiSecret: 'live_api_secret',
      clientId: 'C12345',
      password: 'live_password',
      totpSecret: 'live_totp_secret',
    });
    // No vault decrypt and no DB lookup for the env path.
    expect(withDecrypted).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('defaults apiSecret to "" when ANGEL_ONE_API_SECRET is absent', async () => {
    const { ANGEL_ONE_API_SECRET: _omit, ...envWithoutSecret } = FULL_ENV;
    const provider = new FeedCredentialProvider(
      fakeConfig(envWithoutSecret),
      fakePrisma(jest.fn()),
      fakeDecryptor(jest.fn()),
    );

    const creds = await provider.withFeedCredentials(async (c) => c);
    expect(creds.apiSecret).toBe('');
  });

  // ─── env-WINS precedence ──────────────────────────────────────────────
  it('prefers env creds even when a vault feed account also exists', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'user-feed-1' });
    const withDecrypted = jest.fn();
    const provider = new FeedCredentialProvider(
      fakeConfig(FULL_ENV),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    const creds = await provider.withFeedCredentials(async (c) => c);

    expect(creds.apiKey).toBe('live_api_key');
    expect(withDecrypted).not.toHaveBeenCalled();
  });

  // ─── placeholder detection (falls through to vault) ───────────────────
  it('treats placeholder env values as absent and falls through to the vault', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'user-feed-1' });
    const withDecrypted = jest.fn().mockResolvedValue('vault-result');
    const provider = new FeedCredentialProvider(
      fakeConfig({
        ANGEL_ONE_API_KEY: 'your_api_key_here',
        ANGEL_ONE_CLIENT_ID: 'your_client_id_here',
      }),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    const use = jest.fn(async () => 'ignored');
    const result = await provider.withFeedCredentials(use);

    expect(result).toBe('vault-result');
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(withDecrypted).toHaveBeenCalledTimes(1);
  });

  it('treats empty env values as absent and falls through to the vault', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'user-feed-1' });
    const withDecrypted = jest.fn().mockResolvedValue('vault-result');
    const provider = new FeedCredentialProvider(
      fakeConfig({ ANGEL_ONE_API_KEY: '', ANGEL_ONE_CLIENT_ID: '' }),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    await expect(provider.withFeedCredentials(async (c) => c)).resolves.toBe('vault-result');
    expect(withDecrypted).toHaveBeenCalledTimes(1);
  });

  // ─── vault path ───────────────────────────────────────────────────────
  it('leases the feed account via the decryptor with reason:"FEED"', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'user-feed-1' });
    // Emulate the real lease: invoke the caller's `use` with decrypted creds.
    const vaultCreds: AngelOneCreds = {
      apiKey: 'vault_api_key',
      apiSecret: 'vault_api_secret',
      clientId: 'V99999',
      password: 'vault_password',
      totpSecret: 'vault_totp_secret',
    };
    const withDecrypted = jest.fn(async (_userId, _ctx, use) => use(vaultCreds));
    const provider = new FeedCredentialProvider(
      fakeConfig({}),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    const creds = await provider.withFeedCredentials(async (c) => c);

    expect(creds).toEqual(vaultCreds);
    expect(findFirst).toHaveBeenCalledWith({
      where: { isFeedAccount: true, brokerCredential: { isNot: null } },
      select: { id: true },
    });
    expect(withDecrypted).toHaveBeenCalledWith(
      'user-feed-1',
      { reason: 'FEED' },
      expect.any(Function),
    );
  });

  it('hasFeedCredentials() is true (env) without decrypting anything', async () => {
    const findFirst = jest.fn();
    const withDecrypted = jest.fn();
    const provider = new FeedCredentialProvider(
      fakeConfig(FULL_ENV),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    await expect(provider.hasFeedCredentials()).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
    expect(withDecrypted).not.toHaveBeenCalled();
  });

  it('hasFeedCredentials() is true (vault) without decrypting anything', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'user-feed-1' });
    const withDecrypted = jest.fn();
    const provider = new FeedCredentialProvider(
      fakeConfig({}),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    await expect(provider.hasFeedCredentials()).resolves.toBe(true);
    expect(withDecrypted).not.toHaveBeenCalled();
  });

  // ─── none path ────────────────────────────────────────────────────────
  it('throws NoFeedCredentialsError when neither env nor a vault feed account exists', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const withDecrypted = jest.fn();
    const provider = new FeedCredentialProvider(
      fakeConfig({}),
      fakePrisma(findFirst),
      fakeDecryptor(withDecrypted),
    );

    await expect(provider.withFeedCredentials(async (c) => c)).rejects.toBeInstanceOf(
      NoFeedCredentialsError,
    );
    expect(withDecrypted).not.toHaveBeenCalled();
  });

  it('hasFeedCredentials() is false when there are no feed creds anywhere', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const provider = new FeedCredentialProvider(
      fakeConfig({}),
      fakePrisma(findFirst),
      fakeDecryptor(jest.fn()),
    );

    await expect(provider.hasFeedCredentials()).resolves.toBe(false);
  });
});
