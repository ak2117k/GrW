import { YahooFinanceService } from './yahoo-finance.service';

describe('YahooFinanceService.getIndiaVix', () => {
  let service: YahooFinanceService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    service = new YahooFinanceService();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns India VIX spot when fetch succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: 14.32 },
            },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const vix = await service.getIndiaVix();
    expect(vix).toBe(14.32);
  });

  it('returns null when fetch returns a non-ok status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const vix = await service.getIndiaVix();
    expect(vix).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;

    const vix = await service.getIndiaVix();
    expect(vix).toBeNull();
  });

  it('returns null when payload lacks regularMarketPrice', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: [{ meta: {} }] } }),
    }) as unknown as typeof fetch;

    const vix = await service.getIndiaVix();
    expect(vix).toBeNull();
  });
});

/**
 * `range=5d` with `chartPreviousClose` is the close BEFORE the five-day range,
 * so the old arithmetic reported a ~5-day move as "the daily change". The fix
 * reads the last two daily closes. Fixture: real ^IXIC payload (2026-10-09),
 * trimmed — last close 27366.17, the one before 27193.34, chartPreviousClose
 * 27190.86 (five sessions back).
 */
describe('YahooFinanceService — one-day change', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ixic = require('../../market-cues/__fixtures__/yahoo-ixic.json');
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const serve = (body: unknown) => {
    const fn = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  };

  it('getQuoteChange compares the last two daily closes, not chartPreviousClose', async () => {
    serve(ixic);
    const q = await new YahooFinanceService().getQuoteChange('NIFTY', 'NSE', '99926000');
    expect(q).toEqual({
      previousClose: 27193.34,
      regularMarketPrice: 27366.17,
      regularMarketChange: 172.83,
      regularMarketChangePercent: 0.64,
    });
  });

  it('getQuoteChange returns null rather than a 0 change when there is no prior close', async () => {
    serve({ chart: { result: [{ meta: { regularMarketPrice: 100 }, timestamp: [1], indicators: { quote: [{ close: [100] }] } }] } });
    expect(await new YahooFinanceService().getQuoteChange('NIFTY', 'NSE', '99926000')).toBeNull();
  });

  it('getDailyChangeBySymbol takes a Yahoo symbol directly and reports the session time', async () => {
    const fn = serve(ixic);
    const q = await new YahooFinanceService().getDailyChangeBySymbol('^IXIC');
    expect(String(fn.mock.calls[0][0])).toContain(encodeURIComponent('^IXIC'));
    expect(q).toMatchObject({
      symbol: '^IXIC',
      last: 27366.17,
      previousClose: 27193.34,
      change: 172.83,
      changePercent: 0.64,
      quoteTime: new Date(1791580559 * 1000).toISOString(),
    });
  });
});
