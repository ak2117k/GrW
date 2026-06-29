import { encryptField, decryptField } from './field-crypto';

describe('field-crypto', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-key-32-bytes-long-aaaaaaaaaa';
  });

  it('round-trips a value without leaking the plaintext', () => {
    const cipher = encryptField('s3cret');
    expect(cipher).not.toContain('s3cret');
    expect(decryptField(cipher)).toBe('s3cret');
  });

  it('produces a different ciphertext each call (random iv)', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('uses the base64 iv:tag:ciphertext layout', () => {
    const cipher = encryptField('hello');
    const parts = cipher.split(':');
    expect(parts).toHaveLength(3);
    // iv is 12 bytes, tag is 16 bytes once base64-decoded
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16);
  });

  it('rejects tampered ciphertext', () => {
    const cipher = encryptField('x');
    const bad = cipher.slice(0, -2) + 'aa';
    expect(() => decryptField(bad)).toThrow();
  });

  it('round-trips unicode and empty strings', () => {
    expect(decryptField(encryptField(''))).toBe('');
    expect(decryptField(encryptField('héllo-世界'))).toBe('héllo-世界');
  });
});
