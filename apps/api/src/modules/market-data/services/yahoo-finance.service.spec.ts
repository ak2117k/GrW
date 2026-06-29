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
