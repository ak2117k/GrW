import { encryptWithDataKey, decryptWithDataKey } from '../../src/modules/credential-vault/crypto/field-cipher';
import { randomBytes } from 'crypto';

describe('field-cipher (DEK-keyed)', () => {
  const dk = randomBytes(32);
  it('round-trips under a data key', () => {
    const blob = encryptWithDataKey('s3cr3t-totp', dk);
    expect(decryptWithDataKey(blob, dk)).toBe('s3cr3t-totp');
  });
  it('uses a fresh IV each call (ciphertexts differ)', () => {
    expect(encryptWithDataKey('x', dk)).not.toBe(encryptWithDataKey('x', dk));
  });
  it('throws on a tampered blob (auth-tag fail)', () => {
    const blob = encryptWithDataKey('x', dk);
    const bad = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A');
    expect(() => decryptWithDataKey(bad, dk)).toThrow();
  });
  it('throws when decrypted under the wrong data key', () => {
    const blob = encryptWithDataKey('x', dk);
    expect(() => decryptWithDataKey(blob, randomBytes(32))).toThrow();
  });
});
