import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';

describe('LocalKmsProvider', () => {
  const orig = process.env.ENCRYPTION_KEY;
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'master-key-passphrase-tda004-xxxxxxxx'; });
  afterAll(() => { process.env.ENCRYPTION_KEY = orig; });
  const kms = new LocalKmsProvider();

  it('generateDataKey returns a 32-byte plaintext key + a wrapped blob', async () => {
    const dk = await kms.generateDataKey();
    expect(dk.plaintext).toHaveLength(32);
    expect(typeof dk.wrapped).toBe('string');
    expect(dk.keyVersion).toBe('local-v1');
  });
  it('unwrapKey round-trips the plaintext', async () => {
    const dk = await kms.generateDataKey();
    const back = await kms.unwrapKey(dk.wrapped);
    expect(back.equals(dk.plaintext)).toBe(true);
  });
  it('rejects a tampered wrapped blob', async () => {
    const dk = await kms.generateDataKey();
    const tampered = dk.wrapped.slice(0, -2) + (dk.wrapped.endsWith('A') ? 'B' : 'A');
    await expect(kms.unwrapKey(tampered)).rejects.toThrow();
  });
});
