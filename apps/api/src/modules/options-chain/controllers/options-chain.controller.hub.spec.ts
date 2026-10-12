import { ServiceUnavailableException } from '@nestjs/common';
import { OptionsChainController } from './options-chain.controller';

describe('GET /api/options/chain on the hub', () => {
  const view = (over: object) => ({ chain: [], spotPrice: null, at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', ...over });

  it('an unavailable hub chain is a 503 with the reason', async () => {
    const svc = { getExpiries: jest.fn(), getChainView: jest.fn().mockResolvedValue(view({ status: 'unavailable', unavailable: 'throttled' })) };
    const c = new OptionsChainController(svc as any, {} as any, {} as any, null);
    await expect(c.getChain('NIFTY', { expiry: '2026-10-13' } as any)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('asks as a screen and returns at, source, status and greeks with the chain', async () => {
    const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
    const svc = { getExpiries: jest.fn(), getChainView: jest.fn().mockResolvedValue(view({ chain: entries, spotPrice: 25010, greeks: 'broker' })) };
    const c = new OptionsChainController(svc as any, {} as any, {} as any, null);
    const res = await c.getChain('nifty', { expiry: '2026-10-13' } as any);
    expect(svc.getChainView).toHaveBeenCalledWith('nifty', '2026-10-13', { background: true, screen: true });
    expect(res).toEqual({ chain: entries, expiry: '2026-10-13', spotPrice: 25010, underlying: 'NIFTY', at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', greeks: 'broker' });
  });
});
