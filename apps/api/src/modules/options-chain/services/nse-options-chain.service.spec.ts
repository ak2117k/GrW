import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { NseOptionsChainService } from './nse-options-chain.service';

const FIXTURES = join(__dirname, '__fixtures__');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const NIFTY_INFO = fixture('nse-contract-info-nifty.json');
const NIFTY_V3 = fixture('nse-v3-nifty.json');
const RELIANCE_INFO = fixture('nse-contract-info-reliance.json');
const RELIANCE_V3 = fixture('nse-v3-reliance.json');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function makeConfig(values: Record<string, string> = {}) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

/**
 * Route fetch by URL so each test declares what NSE answers. Unrouted URLs
 * (e.g. the homepage cookie warm-up) answer 403 like NSE does to
 * datacenter clients.
 */
function routeFetch(routes: Array<[RegExp, () => Response | Promise<Response>]>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [re, handler] of routes) {
      if (re.test(url)) return handler();
    }
    return new Response('Forbidden', { status: 403 });
  });
}

describe('NseOptionsChainService (option-chain-v3)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const warnings = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

  describe('parsing v3 payloads', () => {
    it('maps an index chain (NIFTY) into OptionsChainEntry rows', async () => {
      const fetchMock = routeFetch([
        [/option-chain-contract-info\?symbol=NIFTY$/, () => jsonResponse(NIFTY_INFO)],
        [/option-chain-v3\?/, () => jsonResponse(NIFTY_V3)],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      const res = await svc.getChain('nifty', '2026-10-13');

      expect(res).not.toBeNull();
      expect(res!.spotPrice).toBe(22520.45);
      expect(res!.chain.map((e) => e.strikePrice)).toEqual([
        22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700,
      ]);
      const atm = res!.chain.find((e) => e.strikePrice === 22500)!;
      expect(atm.expiryDate).toBe('2026-10-13');
      expect(atm.ceData).toMatchObject({ oi: 146529, delta: 0, gamma: 0, theta: 0, vega: 0 });
      expect(atm.peData).toMatchObject({ oi: 198319 });
      const ce = atm.ceData!;
      expect(ce.ltp).toBeGreaterThan(0);
      expect(ce.iv).toBeGreaterThan(0);
      expect(ce.volume).toBeGreaterThan(0);
      // v3 renamed bidprice/askPrice -> buyPrice1/sellPrice1
      expect(ce.bidPrice).toBeGreaterThan(0);
      expect(ce.askPrice).toBeGreaterThanOrEqual(ce.bidPrice);

      const v3Url = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .find((u) => u.includes('option-chain-v3'))!;
      expect(v3Url).toBe(
        'https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=13-Oct-2026',
      );
    });

    it('maps a stock chain (RELIANCE) using type=Equity', async () => {
      const fetchMock = routeFetch([
        [/option-chain-contract-info\?symbol=RELIANCE$/, () => jsonResponse(RELIANCE_INFO)],
        [/option-chain-v3\?/, () => jsonResponse(RELIANCE_V3)],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      const res = await svc.getChain('RELIANCE', '2026-10-27');

      expect(res).not.toBeNull();
      expect(res!.spotPrice).toBe(1170.3);
      expect(res!.chain).toHaveLength(7);
      const row = res!.chain.find((e) => e.strikePrice === 1200)!;
      expect(row.ceData!.oi).toBe(18833);
      expect(row.peData!.oi).toBe(9619);
      expect(
        fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('option-chain-v3')),
      ).toBe(
        'https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=RELIANCE&expiry=27-Oct-2026',
      );
    });

    it('honours env overrides for both endpoints', async () => {
      const fetchMock = routeFetch([
        [/^https:\/\/nse\.example\/info\?symbol=NIFTY$/, () => jsonResponse(NIFTY_INFO)],
        [/^https:\/\/nse\.example\/v3\?/, () => jsonResponse(NIFTY_V3)],
      ]);
      const svc = new NseOptionsChainService(
        makeConfig({
          NSE_OPTION_CHAIN_INFO_URL: 'https://nse.example/info',
          NSE_OPTION_CHAIN_V3_URL: 'https://nse.example/v3',
        }),
      );

      const res = await svc.getChain('NIFTY', '2026-10-13');

      expect(res).not.toBeNull();
      expect(fetchMock.mock.calls.every((c) => String(c[0]).startsWith('https://nse.example/'))).toBe(true);
    });
  });

  describe('expiry selection', () => {
    it('fetches the requested expiry when NSE lists it', async () => {
      const fetchMock = routeFetch([
        [/option-chain-contract-info/, () => jsonResponse(NIFTY_INFO)],
        [/option-chain-v3\?/, () => jsonResponse(NIFTY_V3)],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      await svc.getChain('NIFTY', '2026-10-27');

      const v3Url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('option-chain-v3'));
      expect(v3Url).toContain('expiry=27-Oct-2026');
    });

    it('returns null without fetching the chain when the requested expiry is not listed', async () => {
      const fetchMock = routeFetch([
        [/option-chain-contract-info/, () => jsonResponse(NIFTY_INFO)],
        [/option-chain-v3\?/, () => jsonResponse(NIFTY_V3)],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      const res = await svc.getChain('NIFTY', '2026-10-14');

      expect(res).toBeNull();
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('option-chain-v3'))).toBe(false);
      expect(warnings()).toMatch(/14-Oct-2026.*13-Oct-2026/s);
    });

    it('picks the nearest upcoming expiry when none is requested', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-14T04:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const fetchMock = routeFetch([
          [/option-chain-contract-info/, () => jsonResponse(NIFTY_INFO)],
          [/option-chain-v3\?/, () => jsonResponse({
            records: {
              ...(NIFTY_V3 as any).records,
              data: (NIFTY_V3 as any).records.data.map((r: any) => ({ ...r, expiryDates: '19-Oct-2026' })),
            },
          })],
        ]);
        const svc = new NseOptionsChainService(makeConfig());

        const res = await svc.getChain('NIFTY');

        const v3Url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('option-chain-v3'));
        expect(v3Url).toContain('expiry=19-Oct-2026');
        expect(res!.chain[0].expiryDate).toBe('2026-10-19');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('failure paths', () => {
    it('returns null and logs the HTTP status on a 404', async () => {
      routeFetch([
        [/option-chain-contract-info/, () => jsonResponse(NIFTY_INFO)],
        [/option-chain-v3\?/, () => new Response('<html>Resource not found</html>', { status: 404 })],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      await expect(svc.getChain('NIFTY', '2026-10-13')).resolves.toBeNull();
      expect(warnings()).toMatch(/HTTP 404/);
    });

    it('returns null and logs err.cause code + message on an undici "fetch failed"', async () => {
      routeFetch([
        [/option-chain-contract-info/, () => {
          const cause = Object.assign(new Error('getaddrinfo ENOTFOUND www.nseindia.com'), {
            code: 'ENOTFOUND',
          });
          throw new TypeError('fetch failed', { cause });
        }],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      await expect(svc.getChain('NIFTY', '2026-10-13')).resolves.toBeNull();
      const logged = warnings();
      expect(logged).toMatch(/fetch failed/);
      expect(logged).toMatch(/ENOTFOUND/);
      expect(logged).toMatch(/getaddrinfo ENOTFOUND www\.nseindia\.com/);
    });

    it('never logs request headers or cookies', async () => {
      routeFetch([
        [/option-chain-contract-info/, () => new Response('denied', { status: 401 })],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      await expect(svc.getChain('NIFTY', '2026-10-13')).resolves.toBeNull();
      const all = [
        ...warn.mock.calls,
        ...(Logger.prototype.log as unknown as jest.Mock).mock.calls,
      ]
        .map((c) => String(c[0]))
        .join('\n');
      expect(all).not.toMatch(/User-Agent|Mozilla|Cookie:/i);
    });

    it('treats a failing homepage cookie warm-up as non-fatal', async () => {
      let infoCalls = 0;
      routeFetch([
        [/^https:\/\/www\.nseindia\.com\/?$/, () => {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
        }],
        [/option-chain-contract-info/, () => {
          infoCalls += 1;
          // First call bounces (forces a warm-up attempt), retry succeeds cookieless.
          return infoCalls === 1 ? new Response('', { status: 403 }) : jsonResponse(NIFTY_INFO);
        }],
        [/option-chain-v3\?/, () => jsonResponse(NIFTY_V3)],
      ]);
      const svc = new NseOptionsChainService(makeConfig());

      const res = await svc.getChain('NIFTY', '2026-10-13');

      expect(res).not.toBeNull();
      expect(res!.chain).toHaveLength(8);
      expect(warnings()).toMatch(/ECONNRESET/);
    });
  });
});
