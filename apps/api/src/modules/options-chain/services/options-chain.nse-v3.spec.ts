import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { NseOptionsChainService } from './nse-options-chain.service';
import { OptionsChainService } from './options-chain.service';
import { GreeksCalculatorService } from './greeks-calculator.service';

/**
 * Caller-side contract for the NSE v3 migration: the chain parsed from a
 * real (trimmed) option-chain-v3 payload must drive PCR, max pain, OI walls
 * and the snapshot writer exactly as the retired endpoint did.
 */

const FIXTURES = join(__dirname, '__fixtures__');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function mockNse(info: unknown, v3: unknown) {
  jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes('option-chain-contract-info')) return jsonResponse(info);
    if (url.includes('option-chain-v3')) return jsonResponse(v3);
    return new Response('Forbidden', { status: 403 });
  });
}

function makeService() {
  const prisma = {
    optionChainSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const nse = new NseOptionsChainService({ get: () => undefined } as any);
  const svc = new OptionsChainService(
    prisma,
    new GreeksCalculatorService(),
    nse,
    null,
    {} as any,
    null,
  );
  return { svc, prisma, nse };
}

describe('OptionsChainService on the NSE v3 chain', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('computes PCR, max pain and OI walls for NIFTY from the v3 fixture', async () => {
    mockNse(fixture('nse-contract-info-nifty.json'), fixture('nse-v3-nifty.json'));
    const { svc, nse } = makeService();

    const res = await nse.getChain('NIFTY', '2026-10-13');
    const chain = res!.chain;

    expect(svc.getPCR(chain)).toBe(1.19);
    expect(svc.getMaxPain(chain)).toBe(22500);
    expect(svc.getOISummary(chain)).toEqual({
      totalCEOI: 598245,
      totalPEOI: 711263,
      pcr: 1.19,
      maxPainStrike: 22500,
      highestCEOIStrike: 22500,
      highestPEOIStrike: 22500,
    });
  });

  it('computes PCR and max pain for a stock (RELIANCE) from the v3 fixture', async () => {
    mockNse(fixture('nse-contract-info-reliance.json'), fixture('nse-v3-reliance.json'));
    const { svc, nse } = makeService();

    const res = await nse.getChain('RELIANCE', '2026-10-27');

    expect(svc.getPCR(res!.chain)).toBe(1.31);
    expect(svc.getMaxPain(res!.chain)).toBe(1180);
  });

  it('serves the v3 chain through getOptionsChainWithSpot and persists an NSE snapshot', async () => {
    // The fixture's expiry is fixed (2026-10-13); greeks need time to expiry, so pin
    // only Date to a morning before it (timers stay real for the setImmediate below).
    jest.useFakeTimers({
      now: new Date('2026-10-12T04:00:00.000Z'),
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    mockNse(fixture('nse-contract-info-nifty.json'), fixture('nse-v3-nifty.json'));
    const { svc, prisma } = makeService();

    const { chain, spotPrice } = await svc.getOptionsChainWithSpot('NIFTY', '2026-10-13');

    expect(spotPrice).toBe(22520.45);
    expect(chain).toHaveLength(8);
    // enrichGreeks ran on the NSE rows
    expect(chain.find((e) => e.strikePrice === 22500)!.ceData!.delta).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    expect(prisma.optionChainSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        underlying: 'NIFTY',
        source: 'NSE',
        strikeCount: 8,
        spotPrice: 22520.45,
      }),
    });
  });
});
