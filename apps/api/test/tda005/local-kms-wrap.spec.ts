import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';
import { randomBytes } from 'crypto';

describe('LocalKmsProvider.wrapKey', () => {
  const orig = process.env.ENCRYPTION_KEY;
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'master-key-passphrase-tda005-xxxxxxxx'; });
  afterAll(() => { process.env.ENCRYPTION_KEY = orig; });
  const kms = new LocalKmsProvider();

  it('wrapKey round-trips through unwrapKey', async () => {
    const dek = randomBytes(32);
    const { wrapped, keyVersion } = await kms.wrapKey(dek);
    expect(keyVersion).toBe('local-v1');
    expect((await kms.unwrapKey(wrapped)).equals(dek)).toBe(true);
  });
  it('rejects a tampered wrapped blob', async () => {
    const { wrapped } = await kms.wrapKey(randomBytes(32));
    const bad = wrapped.slice(0, -2) + (wrapped.endsWith('A') ? 'B' : 'A');
    await expect(kms.unwrapKey(bad)).rejects.toThrow();
  });
});
