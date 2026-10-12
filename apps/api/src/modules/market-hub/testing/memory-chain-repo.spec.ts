import type { ChainContract, HubChain } from '../chain/chain.types';
import { MemoryChainRepo } from './memory-chain-repo';

const c: ChainContract = { instrumentId: 'i1', ref: { exchange: 'NFO', token: '1', symbol: 'NIFTY25000CE' }, strike: 25000, optionType: 'CE', lotSize: 75 };

describe('MemoryChainRepo', () => {
  it('normalises underlying names to upper-case on write and read, like PrismaChainRepo', async () => {
    const repo = new MemoryChainRepo();
    repo.addContracts('nifty', '2026-10-13', [c]);
    await expect(repo.contracts('NIFTY', '2026-10-13')).resolves.toEqual([c]);
    await expect(repo.contracts('Nifty', '2026-10-13')).resolves.toEqual([c]);
    await expect(repo.expiries('nifty', '2026-10-01')).resolves.toEqual(['2026-10-13']);
  });

  it('reads back a stored chain case-insensitively, keeping its own greeks label and the caller venue', async () => {
    const repo = new MemoryChainRepo();
    const chain: HubChain = { underlying: 'crudeoil', expiry: '2026-10-16', exchange: 'NFO', spot: null, at: 1, greeks: 'local', entries: [] };
    await repo.writeChainSnapshot(chain);
    await expect(repo.latestChainSnapshot('CRUDEOIL', '2026-10-16', 'MCX')).resolves.toEqual(
      expect.objectContaining({ greeks: 'local', exchange: 'MCX', expiry: '2026-10-16' }),
    );
    await expect(repo.latestChainSnapshot('CRUDEOILM', '2026-10-16', 'MCX')).resolves.toBeNull();
  });
});
