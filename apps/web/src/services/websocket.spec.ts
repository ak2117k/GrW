import { describe, expect, it } from 'vitest';
import { buildHandshakeAuth, replayPayloads, toSubscribePayload } from './websocket';

describe('buildHandshakeAuth', () => {
  it('builds handshake auth from a token', () => {
    expect(buildHandshakeAuth('abc')).toEqual({ token: 'abc' });
  });

  it('passes through an empty token unchanged', () => {
    expect(buildHandshakeAuth('')).toEqual({ token: '' });
  });
});

describe('toSubscribePayload', () => {
  it('sends refs with their exchange (upper-cased) and purpose, plus bare tokens for an old server', () => {
    expect(toSubscribePayload([{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }, { token: '2885', exchange: 'NSE' }], 'chart')).toEqual({
      tokens: ['35001', '2885'],
      refs: [
        { token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' },
        { token: '2885', exchange: 'NSE' },
      ],
      purpose: 'chart',
    });
  });

  it('omits the purpose when none is given (unsubscribe)', () => {
    expect(toSubscribePayload([])).toEqual({ tokens: [], refs: [] });
  });
});

describe('replayPayloads', () => {
  it('groups every held subscription by purpose, one payload each', () => {
    expect(
      replayPayloads([
        { ref: { token: '1', exchange: 'NSE' }, purpose: 'watchlist' },
        { ref: { token: '2', exchange: 'NFO' }, purpose: 'chart' },
        { ref: { token: '3', exchange: 'NSE' }, purpose: 'watchlist' },
      ]),
    ).toEqual([
      { tokens: ['1', '3'], refs: [{ token: '1', exchange: 'NSE' }, { token: '3', exchange: 'NSE' }], purpose: 'watchlist' },
      { tokens: ['2'], refs: [{ token: '2', exchange: 'NFO' }], purpose: 'chart' },
    ]);
  });
});
