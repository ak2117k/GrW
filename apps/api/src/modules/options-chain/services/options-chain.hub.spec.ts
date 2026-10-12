import { Logger } from '@nestjs/common';
import { OptionsChainService } from './options-chain.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { NseOptionsChainService } from './nse-options-chain.service';

const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
const hubChain = { underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: 25010, at: Date.now(), greeks: 'broker', entries };

function make(chains: Record<string, jest.Mock> | null) {
  const source = { hubFor: jest.fn(() => (chains ? { chains } : null)), record: jest.fn() };
  const moduleRef = { get: jest.fn(() => source) };
  const prisma = { optionChainSnapshot: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) } } as any;
  const nse = new NseOptionsChainService({ get: () => undefined } as any);
  const svc = new OptionsChainService(prisma, new GreeksCalculatorService(), nse, null, {} as any, null, moduleRef as any);
  return { svc, source, nse };
}

describe('OptionsChainService on the market hub', () => {
  beforeEach(() => {
    for (const level of ['warn', 'log', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('serves the hub chain with its labels when hubFor(null, "chain") answers, and counts it', async () => {
    const chains = { chain: jest.fn().mockResolvedValue({ kind: 'fresh', chain: hubChain }), expiries: jest.fn(), optionLtp: jest.fn() };
    const { svc, source } = make(chains);
    const view = await svc.getChainView('NIFTY', '2026-10-13', { screen: true });
    expect(source.hubFor).toHaveBeenCalledWith(null, 'chain');
    expect(chains.chain).toHaveBeenCalledWith('NIFTY', '2026-10-13', { screen: true });
    expect(view).toEqual(expect.objectContaining({ chain: entries, spotPrice: 25010, source: 'hub', status: 'fresh' }));
    expect(source.record).toHaveBeenCalledWith('chain', 'hub');
    await expect(svc.getOptionsChainWithSpot('NIFTY', '2026-10-13')).resolves.toEqual({ chain: entries, spotPrice: 25010 });
  });

  it('an unavailable hub chain is an empty chain for internal consumers, never a synthetic one', async () => {
    const chains = { chain: jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'throttled' }), expiries: jest.fn(), optionLtp: jest.fn() };
    const { svc, source, nse } = make(chains);
    const nseSpy = jest.spyOn(nse, 'getChain');
    await expect(svc.getOptionsChain('NIFTY', '2026-10-13')).resolves.toEqual([]);
    expect(nseSpy).not.toHaveBeenCalled();
    expect(source.record).toHaveBeenCalledWith('chain', 'unpriced');
  });

  it('expiries and single-contract LTP come from the hub', async () => {
    const chains = { chain: jest.fn(), expiries: jest.fn().mockResolvedValue(['2026-10-13']), optionLtp: jest.fn().mockResolvedValue(131.25) };
    const { svc } = make(chains);
    await expect(svc.getExpiries('NIFTY')).resolves.toEqual(['2026-10-13']);
    await expect(svc.getLiveOptionLtp('NIFTY', '2026-10-13T00:00:00.000Z', 25000, 'CE')).resolves.toBe(131.25);
    expect(chains.optionLtp).toHaveBeenCalledWith('NIFTY', '2026-10-13', 25000, 'CE');
  });

  it('with the switch off (hubFor null) the legacy path answers, labelled with its source', async () => {
    const { svc, nse } = make(null);
    jest.spyOn(nse, 'getChain').mockResolvedValue({ chain: entries, spotPrice: 24990 } as any);
    const view = await svc.getChainView('NIFTY', '2026-10-13');
    expect(view).toEqual(expect.objectContaining({ chain: expect.any(Array), spotPrice: 24990, source: 'nse' }));
  });
});
