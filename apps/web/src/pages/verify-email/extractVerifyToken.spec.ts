import { describe, it, expect } from 'vitest';
import { extractVerifyToken } from './extractVerifyToken';

describe('extractVerifyToken', () => {
  it('extracts the token', () => expect(extractVerifyToken('?token=abc123')).toBe('abc123'));
  it('ignores other params', () =>
    expect(extractVerifyToken('?foo=1&token=xyz&bar=2')).toBe('xyz'));
  it('returns null when missing', () => expect(extractVerifyToken('?foo=1')).toBeNull());
  it('returns null for empty token', () => expect(extractVerifyToken('?token=')).toBeNull());
  it('returns null for empty search', () => expect(extractVerifyToken('')).toBeNull());
});
