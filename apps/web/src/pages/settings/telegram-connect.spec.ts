import { describe, expect, it } from 'vitest';
import {
  MAX_CHANNELS,
  cleanCode,
  errorMessage,
  sameSelection,
  stepFromStatus,
  toStartPayload,
  toggleChannel,
  validateCode,
  validateCredentials,
} from './telegram-connect';

const good = { apiId: '1234567', apiHash: '0123456789abcdef0123456789ABCDEF', phone: '+91 98765 43210' };

describe('telegram connect form logic', () => {
  it('validates the credentials form', () => {
    expect(validateCredentials(good)).toBeNull();
    expect(validateCredentials({ ...good, apiId: 'abc' })).toMatch(/api_id/);
    expect(validateCredentials({ ...good, apiHash: 'short' })).toMatch(/api_hash/);
    expect(validateCredentials({ ...good, phone: '98765 43210' })).toMatch(/international/);
  });

  it('builds the start payload with a numeric api id and trimmed values', () => {
    expect(toStartPayload({ apiId: ' 42 ', apiHash: ` ${good.apiHash} `, phone: ' +91 1 ' })).toEqual({
      apiId: 42,
      apiHash: good.apiHash,
      phone: '+91 1',
    });
  });

  it('cleans and validates the login code', () => {
    expect(cleanCode('12 345')).toBe('12345');
    expect(validateCode('12-345')).toBeNull();
    expect(validateCode('123')).toMatch(/code/);
  });

  it('resumes at the right step', () => {
    expect(stepFromStatus({ connected: false, pending: null })).toBe('credentials');
    expect(stepFromStatus({ connected: false, pending: 'password' })).toBe('password');
    expect(stepFromStatus({ connected: true, pending: null })).toBe('connected');
  });

  it('toggles channels up to the cap', () => {
    let sel: string[] = [];
    for (let i = 0; i < MAX_CHANNELS + 2; i++) sel = toggleChannel(sel, `c${i}`);
    expect(sel).toHaveLength(MAX_CHANNELS);
    sel = toggleChannel(sel, 'c0');
    expect(sel).not.toContain('c0');
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSelection(['a'], ['b'])).toBe(false);
  });

  it('extracts server messages', () => {
    expect(errorMessage({ response: { data: { message: 'wrong code' } } }, 'x')).toBe('wrong code');
    expect(errorMessage({ response: { data: { message: ['bad phone'] } } }, 'x')).toBe('bad phone');
    expect(errorMessage(new Error('net'), 'fallback')).toBe('fallback');
  });
});
