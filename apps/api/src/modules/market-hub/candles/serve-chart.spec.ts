import type { HubCandleSource } from '../hub-candle-source';
import { serveChartFromHub, type ChartRequest } from './serve-chart';

const REQ: ChartRequest = {
  token: '2885', exchange: 'NSE', symbol: 'RELIANCE', timeframe: '15m',
  from: new Date('2026-10-06T18:30:00.000Z'), to: new Date('2026-10-07T18:30:00.000Z'),
};
function hub(over: Partial<HubCandleSource> = {}): HubCandleSource {
  return {
    servesCharts: () => true,
    candles: jest.fn().mockResolvedValue({
      candles: [{ ts: Date.parse('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }],
      incomplete: [{ from: Date.parse('2026-10-06T18:30:00.000Z'), to: Date.parse('2026-10-07T18:30:00.000Z'), reason: 'deferred' }],
    }),
    ...over,
  };
}

describe('serveChartFromHub', () => {
  const warn = jest.fn();
  beforeEach(() => warn.mockReset());

  it('maps the hub result to the legacy /candles response, with incomplete ranges', async () => {
    const h = hub();
    const out = await serveChartFromHub(h, REQ, warn);
    expect(h.candles).toHaveBeenCalledWith({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }, '15m', REQ.from, REQ.to);
    expect(out).toEqual({
      token: '2885', symbol: 'RELIANCE', timeframe: '15m',
      candles: [{ timestamp: new Date('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }],
      count: 1, source: 'hub',
      incomplete: [{ from: '2026-10-06T18:30:00.000Z', to: '2026-10-07T18:30:00.000Z', reason: 'deferred' }],
    });
  });

  it('accepts a lower-case exchange', async () => {
    const h = hub();
    await serveChartFromHub(h, { ...REQ, exchange: 'nfo' }, warn);
    expect(h.candles).toHaveBeenCalledWith(expect.objectContaining({ exchange: 'NFO' }), '15m', REQ.from, REQ.to);
  });

  it('returns null (legacy path) when there is no hub, the switch is off, or the request is not hub-shaped', async () => {
    expect(await serveChartFromHub(null, REQ, warn)).toBeNull();
    expect(await serveChartFromHub(hub({ servesCharts: () => false }), REQ, warn)).toBeNull();
    expect(await serveChartFromHub(hub(), { ...REQ, exchange: 'CDS' }, warn)).toBeNull();
    expect(await serveChartFromHub(hub(), { ...REQ, timeframe: '4h' }, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy path, with a warning, when the hub throws', async () => {
    const out = await serveChartFromHub(hub({ candles: jest.fn().mockRejectedValue(new Error('db down')) }), REQ, warn);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/db down/));
  });
});
