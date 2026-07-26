import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { classifyLoginError, COLD_START_MESSAGE } from './loginError';

const FALLBACK = 'Unable to sign in. Please try again.';

/** Build an AxiosError carrying an HTTP response with the given status/body. */
function withResponse(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  err.response = {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

/** Build an AxiosError with NO response — a timeout / network drop / CORS. */
function withoutResponse(code: string): AxiosError {
  return new AxiosError('timeout of 45000ms exceeded', code);
}

describe('classifyLoginError', () => {
  it('maps 401 to a credentials message', () => {
    expect(classifyLoginError(withResponse(401, { message: 'Invalid credentials' }), FALLBACK)).toBe(
      'Invalid email or password.',
    );
  });

  it('maps 429 to a rate-limit message', () => {
    expect(classifyLoginError(withResponse(429, {}), FALLBACK)).toBe(
      'Too many attempts. Please wait and try again.',
    );
  });

  it('surfaces a cold-start message on a timeout (no response)', () => {
    expect(classifyLoginError(withoutResponse('ECONNABORTED'), FALLBACK)).toBe(COLD_START_MESSAGE);
  });

  it('surfaces a cold-start message on a network error (no response)', () => {
    expect(classifyLoginError(withoutResponse('ERR_NETWORK'), FALLBACK)).toBe(COLD_START_MESSAGE);
  });

  it('passes through a string server message on other statuses', () => {
    expect(classifyLoginError(withResponse(400, { message: 'Email is required' }), FALLBACK)).toBe(
      'Email is required',
    );
  });

  it('passes through the first entry of an array server message', () => {
    expect(
      classifyLoginError(withResponse(400, { message: ['Email is required', 'x'] }), FALLBACK),
    ).toBe('Email is required');
  });

  it('falls back when a response has no usable message', () => {
    expect(classifyLoginError(withResponse(500, {}), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for a non-Axios error', () => {
    expect(classifyLoginError(new Error('boom'), FALLBACK)).toBe(FALLBACK);
  });
});
