import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { NseOptionsChainService } from './nse-options-chain.service';
import { OptionsChainService } from './options-chain.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { OptionsChainController } from '../controllers/options-chain.controller';
import { OiWallService } from '../../signal-generator/services/oi-wall.service';
import { MarketContextService } from '../../market-data/services/market-context.service';

/**
 * The NSE caller-side wait is split: hot paths (sentinel tick, 30 s sweeps,
 * scans, trade-entry context) keep 3000 ms; the /options REST endpoints opt
 * into the longer, env-configurable budget (NSE_OPTION_CHAIN_TIMEOUT_MS,
 * default 8000 ms).
 */

const FIXTURES = join(__dirname, '__fixtures__');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function mockNse() {
  const info = fixture('nse-contract-info-nifty.json');
  const v3 = fixture('nse-v3-nifty.json');
  jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes('option-chain-contract-info')) return jsonResponse(info);
    if (url.includes('option-chain-v3')) return jsonResponse(v3);
    return new Response('Forbidden', { status: 403 });
  });
}

const nseWith = (env: Record<string, string | undefined> = {}) =>
  new NseOptionsChainService({ get: (k: string) => env[k] } as any);

function makeService(env: Record<string, string | undefined> = {}) {
  const prisma = {
    optionChainSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const svc = new OptionsChainService(
    prisma,
    new GreeksCalculatorService(),
    nseWith(env),
    null,
    {} as any,
    null,
  );
  const withTimeout = jest.spyOn(svc as any, 'withTimeout');
  return { svc, withTimeout };
}

const nseWaitMs = (spy: jest.SpyInstance): number => {
  const call = spy.mock.calls.find((c) => c[2] === 'NSE direct fetch');
  expect(call).toBeDefined();
  return call![1];
};

describe('NSE option-chain timeout split', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('NseOptionsChainService.backgroundTimeoutMs', () => {
    it('defaults to 8000 ms when NSE_OPTION_CHAIN_TIMEOUT_MS is unset', () => {
      expect(nseWith().backgroundTimeoutMs).toBe(8000);
    });

    it('reads NSE_OPTION_CHAIN_TIMEOUT_MS', () => {
      expect(nseWith({ NSE_OPTION_CHAIN_TIMEOUT_MS: '12000' }).backgroundTimeoutMs).toBe(12000);
    });

    it.each(['', '0', '-5', 'abc'])('falls back to 8000 ms for invalid value %p', (v) => {
      expect(nseWith({ NSE_OPTION_CHAIN_TIMEOUT_MS: v }).backgroundTimeoutMs).toBe(8000);
    });
  });

  describe('OptionsChainService', () => {
    it('hot path (no options) waits 3000 ms regardless of the env value', async () => {
      mockNse();
      const { svc, withTimeout } = makeService({ NSE_OPTION_CHAIN_TIMEOUT_MS: '12000' });
      const { chain } = await svc.getOptionsChainWithSpot('NIFTY', '2026-10-13');
      expect(chain.length).toBeGreaterThan(0);
      expect(nseWaitMs(withTimeout)).toBe(3000);
    });

    it('getOptionsChain without options is also the 3000 ms hot path', async () => {
      mockNse();
      const { svc, withTimeout } = makeService();
      await svc.getOptionsChain('NIFTY', '2026-10-13');
      expect(nseWaitMs(withTimeout)).toBe(3000);
    });

    it('background waits the default 8000 ms', async () => {
      mockNse();
      const { svc, withTimeout } = makeService();
      await svc.getOptionsChainWithSpot('NIFTY', '2026-10-13', { background: true });
      expect(nseWaitMs(withTimeout)).toBe(8000);
    });

    it('background waits the env value when set', async () => {
      mockNse();
      const { svc, withTimeout } = makeService({ NSE_OPTION_CHAIN_TIMEOUT_MS: '12000' });
      await svc.getOptionsChain('NIFTY', '2026-10-13', { background: true });
      expect(nseWaitMs(withTimeout)).toBe(12000);
    });
  });

  describe('callers', () => {
    const chainStub = () => ({
      getExpiries: jest.fn().mockResolvedValue(['2026-10-13']),
      getOptionsChain: jest.fn().mockResolvedValue([]),
      getOptionsChainWithSpot: jest.fn().mockResolvedValue({ chain: [], spotPrice: 0 }),
      getOISummary: jest.fn().mockReturnValue({}),
      getPCR: jest.fn().mockReturnValue(0),
      getMaxPain: jest.fn().mockReturnValue(0),
    });

    it('REST chain and analysis endpoints request the background budget', async () => {
      const chain = chainStub();
      const ctl = new OptionsChainController(chain as any, {} as any, {} as any, null);

      await ctl.getChain('NIFTY', { expiry: '2026-10-13' } as any);
      await ctl.getAnalysis('NIFTY', { expiry: '2026-10-13' } as any);

      expect(chain.getOptionsChainWithSpot).toHaveBeenCalledWith('NIFTY', '2026-10-13', { background: true });
      expect(chain.getOptionsChain).toHaveBeenCalledWith('NIFTY', '2026-10-13', { background: true });
    });

    it('OiWallService (sentinel tick, chart S/R) stays on the hot path', async () => {
      const chain = chainStub();
      const oi = new OiWallService(chain as any);

      await oi.walls('NIFTY', 22500);

      expect(chain.getOptionsChain).toHaveBeenCalledWith('NIFTY', '2026-10-13');
    });

    it('MarketContextService (inline in trade execution) stays on the hot path', async () => {
      const chain = chainStub();
      const ctx = new MarketContextService(
        { getIndiaVix: jest.fn().mockResolvedValue(null) } as any,
        { getQuote: jest.fn().mockReturnValue(null), getBreadth: jest.fn().mockReturnValue(null) } as any,
        chain as any,
      );

      await ctx.snapshot('NIFTY');

      expect(chain.getOptionsChainWithSpot).toHaveBeenCalledWith('NIFTY', '2026-10-13');
    });
  });
});
