import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { ChainContract, HubChain } from './chain.types';
import { OiSnapshotJob, type OiSnapshotJobDeps } from './oi-snapshot-job';

const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const E = '2026-10-13';
const ce: ChainContract = { instrumentId: 'i-ce', ref: { exchange: 'NFO', token: 'T1', symbol: 'N25000CE' }, strike: 25000, optionType: 'CE', lotSize: 75 };
const pe: ChainContract = { instrumentId: 'i-pe', ref: { exchange: 'NFO', token: 'T2', symbol: 'N25000PE' }, strike: 25000, optionType: 'PE', lotSize: 75 };
const leg = (token: string, oi: number, oiChange: number | null) => ({ ltp: 10, oi, oiChange, volume: 3, iv: 12, delta: 0, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0, token, lotSize: 75 });
const chain = (at: number): HubChain => ({
  underlying: 'NIFTY', expiry: E, exchange: 'NFO', spot: 25000, at, greeks: 'broker',
  entries: [{ strikePrice: 25000, expiryDate: E, ceData: leg('T1', 1000, 50), peData: leg('T2', 2000, null) }],
});

function job(over: Partial<OiSnapshotJobDeps> = {}) {
  const repo = new MemoryChainRepo();
  const built: number[] = [];
  const j = new OiSnapshotJob({
    targets: async () => [{ underlying: 'NIFTY', expiry: E }],
    contracts: async () => [ce, pe],
    freshChain: async () => {
      const at = Date.now();
      built.push(at);
      return chain(at);
    },
    repo,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    ...over,
  });
  return { j, repo, built };
}

describe('OiSnapshotJob', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('writes one OI row per quoted contract (null oiChange kept) every 3 minutes while open', async () => {
    const { j, repo } = job();
    jest.setSystemTime(IST('2026-10-12T10:00:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toEqual([
      { instrumentId: 'i-ce', oi: 1000, oiChange: 50, volume: 3, at: new Date(IST('2026-10-12T10:00:00')) },
      { instrumentId: 'i-pe', oi: 2000, oiChange: null, volume: 3, at: new Date(IST('2026-10-12T10:00:00')) },
    ]);
    jest.setSystemTime(IST('2026-10-12T10:01:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(2);
    jest.setSystemTime(IST('2026-10-12T10:03:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(4);
  });

  it('stores the chain JSON on the first run and every 5th run after', async () => {
    const { j, repo } = job();
    for (let i = 0; i < 6; i++) {
      jest.setSystemTime(IST('2026-10-12T10:00:00') + i * 180_000);
      await j.tick(Date.now());
    }
    expect(repo.chainSnapshots).toHaveLength(2); // runs 1 and 6
  });

  it('writes one closing snapshot when the venue closes, then nothing', async () => {
    const { j, repo } = job();
    jest.setSystemTime(IST('2026-10-12T15:28:00'));
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T15:30:30'));
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T15:40:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(4);
    expect(repo.chainSnapshots).toHaveLength(2); // first run + closing run
  });

  it('with writeChainJson() false it writes OI rows but no chain JSON, not even at the close', async () => {
    const { j, repo } = job({ writeChainJson: () => false });
    for (let i = 0; i < 6; i++) {
      jest.setSystemTime(IST('2026-10-12T15:10:00') + i * 180_000);
      await j.tick(Date.now());
    }
    jest.setSystemTime(IST('2026-10-12T15:30:30'));
    await j.tick(Date.now()); // the closing run
    expect(repo.oiRows).toHaveLength(14); // 6 open runs + the closing run, 2 legs each
    expect(repo.chainSnapshots).toHaveLength(0);
  });

  it('with writeChainJson() true it stores chain JSON as before (first run, every 5th, close)', async () => {
    const { j, repo } = job({ writeChainJson: () => true });
    for (let i = 0; i < 6; i++) {
      jest.setSystemTime(IST('2026-10-12T15:10:00') + i * 180_000);
      await j.tick(Date.now());
    }
    jest.setSystemTime(IST('2026-10-12T15:30:30'));
    await j.tick(Date.now());
    expect(repo.chainSnapshots).toHaveLength(3); // runs 1 and 6 + the closing run
  });

  it('skips a holiday and a closed venue entirely', async () => {
    const { j, repo, built } = job();
    jest.setSystemTime(IST('2026-10-02T11:00:00')); // Gandhi Jayanti (NSE holiday in MARKET_HOLIDAYS)
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T20:00:00'));
    await j.tick(Date.now());
    expect(built).toHaveLength(0);
    expect(repo.oiRows).toHaveLength(0);
  });

  it('a chain that cannot be built writes nothing and is counted; a write failure is counted, not thrown', async () => {
    const none = job({ freshChain: async () => null });
    jest.setSystemTime(IST('2026-10-12T10:00:00'));
    await none.j.tick(Date.now());
    expect(none.repo.oiRows).toHaveLength(0);
    expect(none.j.status(Date.now()).failures).toBe(1);

    const broken = job();
    broken.repo.writeOi = async () => {
      throw new Error('db down');
    };
    await expect(broken.j.tick(Date.now())).resolves.toBeUndefined();
    expect(broken.j.status(Date.now()).failures).toBe(1);
  });
});
