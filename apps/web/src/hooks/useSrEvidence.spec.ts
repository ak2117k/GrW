import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { get } = vi.hoisted(() => ({ get: vi.fn(() => Promise.resolve({ data: { evidence: [] } })) }));
vi.mock('@/services/api', () => ({ default: { get } }));

import { useSrEvidence } from './useSrEvidence';

/** See useZones.spec.ts for why we capture `refetch` via the server renderer. */
function captureRefetch(
  token: string | null,
  exchange: string | null,
  timeframe: string | null,
): () => void {
  let captured: () => void = () => {};
  function Probe() {
    const { refetch } = useSrEvidence(token, exchange, timeframe);
    captured = refetch;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return captured;
}

describe('useSrEvidence request params', () => {
  beforeEach(() => {
    get.mockClear();
  });

  it('sends the selected timeframe as interval', async () => {
    await captureRefetch('123', 'NSE', '1m')();
    expect(get).toHaveBeenCalledWith(
      '/signals/sr-evidence',
      expect.objectContaining({
        params: expect.objectContaining({ token: '123', exchange: 'NSE', interval: '1m' }),
      }),
    );
  });

  it('defaults interval to 15m when timeframe is null', async () => {
    await captureRefetch('123', 'NSE', null)();
    expect(get).toHaveBeenCalledWith(
      '/signals/sr-evidence',
      expect.objectContaining({
        params: expect.objectContaining({ interval: '15m' }),
      }),
    );
  });
});
