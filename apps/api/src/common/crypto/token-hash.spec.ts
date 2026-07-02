import { createHash } from 'crypto';
import { sha256Hex } from './token-hash';

describe('sha256Hex', () => {
  it('returns a lowercase 64-char hex digest', () => {
    const out = sha256Hex('some-opaque-token');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and matches Node crypto', () => {
    const value = 'refresh-token-value';
    const expected = createHash('sha256').update(value).digest('hex');
    expect(sha256Hex(value)).toBe(expected);
    expect(sha256Hex(value)).toBe(sha256Hex(value));
  });

  it('produces different digests for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});
