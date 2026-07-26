import { describe, expect, it } from 'vitest';
import { buildHandshakeAuth, toSubscribePayload } from './websocket';

describe('buildHandshakeAuth', () => {
  it('builds handshake auth from a token', () => {
    expect(buildHandshakeAuth('abc')).toEqual({ token: 'abc' });
  });

  it('passes through an empty token unchanged', () => {
    expect(buildHandshakeAuth('')).toEqual({ token: '' });
  });
});

describe('toSubscribePayload', () => {
  it('shapes a subscribe payload', () => {
    expect(toSubscribePayload(['1', '2'])).toEqual({ tokens: ['1', '2'] });
  });

  it('shapes an empty token list', () => {
    expect(toSubscribePayload([])).toEqual({ tokens: [] });
  });
});
