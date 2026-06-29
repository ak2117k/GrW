import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Mock the shared axios instance so no real network call happens.
// `vi.hoisted` keeps the spy available inside the hoisted vi.mock factory.
const { get } = vi.hoisted(() => ({ get: vi.fn(() => Promise.resolve({ data: { zones: [] } })) }));
vi.mock('@/services/api', () => ({ default: { get } }));

import { useZones } from './useZones';

/**
 * The project has no DOM/renderer (no jsdom/RTL) in its vitest setup, so we
 * can't drive `useEffect`. Instead we render the hook once via the server
 * renderer (which runs the component body + builds the memoised `refetch`),
 * capture the returned `refetch`, then invoke it directly to assert the
 * outbound request params. This exercises the real fetch code path.
 */
function captureRefetch(
  token: string | null,
  exchange: string | null,
  timeframe: string | null,
): () => void {
  let captured: () => void = () => {};
  function Probe() {
    const { refetch } = useZones(token, exchange, timeframe);
    captured = refetch;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return captured;
}

describe('useZones request params', () => {
  beforeEach(() => {
    get.mockClear();
  });

  it('sends the selected timeframe as interval', async () => {
    await captureRefetch('123', 'NSE', '5m')();
    expect(get).toHaveBeenCalledWith(
      '/signals/zones',
      expect.objectContaining({
        params: expect.objectContaining({ token: '123', exchange: 'NSE', interval: '5m' }),
      }),
    );
  });

  it('defaults interval to 15m when timeframe is null', async () => {
    await captureRefetch('123', 'NSE', null)();
    expect(get).toHaveBeenCalledWith(
      '/signals/zones',
      expect.objectContaining({
        params: expect.objectContaining({ interval: '15m' }),
      }),
    );
  });
});
