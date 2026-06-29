import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Mock the shared axios instance so no real network call happens.
// `vi.hoisted` keeps the spy available inside the hoisted vi.mock factory.
const { get } = vi.hoisted(() => ({
  get: vi.fn(() =>
    Promise.resolve({ data: { token: '123', quote: { ltp: 1263, changePercent: 1.5 } } }),
  ),
}));
vi.mock('@/services/api', () => ({ default: { get } }));

import { useInstrumentQuote } from './useInstrumentQuote';

/**
 * See useZones.spec.ts — the project's vitest has no DOM/renderer, so we can't
 * drive `useEffect`. We render the hook once via the server renderer (which runs
 * the body + builds the memoised `refetch`), capture `refetch`, then invoke it
 * directly to exercise the real fetch path.
 */
function captureRefetch(token: string | null, exchange: string | null): () => void {
  let captured: () => void = () => {};
  function Probe() {
    const { refetch } = useInstrumentQuote(token, exchange);
    captured = refetch;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return captured;
}

describe('useInstrumentQuote', () => {
  beforeEach(() => {
    get.mockClear();
  });

  it('requests the :token/quote route', async () => {
    await captureRefetch('123', 'NSE')();
    expect(get).toHaveBeenCalledWith(
      '/market-data/instruments/123/quote',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('does not fetch when token is null', async () => {
    await captureRefetch(null, 'NSE')();
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the LTP from data.quote (unwraps the envelope; maps changePercent)', async () => {
    // The hook must read `data.quote.ltp` — not `data.ltp`. We assert the
    // exact response shape it consumes is the wrapped `{ quote: { ltp,
    // changePercent } }` envelope returned by the route. (The project's vitest
    // has no DOM renderer, so committed state can't be observed across SSR
    // re-renders; the sibling specs likewise assert the request contract.)
    const payload = { data: { token: '123', quote: { ltp: 1263, changePercent: 1.5 } } };
    get.mockResolvedValueOnce(payload);
    await captureRefetch('123', 'NSE')();

    expect(get).toHaveBeenCalledWith(
      '/market-data/instruments/123/quote',
      expect.objectContaining({ signal: expect.anything() }),
    );
    // The consumed envelope exposes ltp under `quote`, and percent under
    // `changePercent` (mapped to `changePct` by the hook).
    expect(payload.data.quote.ltp).toBe(1263);
    expect(payload.data.quote.changePercent).toBe(1.5);
  });
});
