import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { BuildOutcome } from './chain-builder';
import type { ChainContract, HubChain } from './chain.types';
import { CHAIN_AWAIT_DEADLINE_MS, ChainService, type ChainServiceDeps } from './chain-service';

const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const E = '2026-10-13';
const nfo = (strike: number): ChainContract => ({ instrumentId: `i${strike}`, ref: { exchange: 'NFO', token: `T${strike}`, symbol: `N${strike}` }, strike, optionType: 'CE', lotSize: 75 });
const mcx = (strike: number): ChainContract => ({ instrumentId: `m${strike}`, ref: { exchange: 'MCX', token: `M${strike}`, symbol: `C${strike}` }, strike, optionType: 'CE', lotSize: 100 });
const chainAt = (underlying: string, at: number, exchange: 'NFO' | 'MCX' = 'NFO'): HubChain => ({
  underlying, expiry: E, exchange, spot: 25000, at, greeks: 'broker', entries: [{ strikePrice: 25000, expiryDate: E, ceData: null, peData: null }],
});

function service(start: string, over: Partial<ChainServiceDeps> = {}) {
  let now = IST(start);
  const builds: Array<{ u: string; lane: number }> = [];
  let next: (u: string) => BuildOutcome = (u) => ({ kind: 'ok', chain: chainAt(u, now, u === 'CRUDEOIL' ? 'MCX' : 'NFO') });
  const repo = new MemoryChainRepo();
  const contracts: Record<string, ChainContract[]> = { NIFTY: [nfo(25000)], CRUDEOIL: [mcx(6000)] };
  const deps: ChainServiceDeps = {
    builder: {
      contracts: async (u) => contracts[u] ?? [],
      expiries: async (u) => (contracts[u] ? [E] : []),
      contractFor: async (u, _e, strike, type) => (contracts[u] ?? []).find((c) => c.strike === strike && c.optionType === type) ?? null,
      build: async (u, _e, o) => {
        builds.push({ u, lane: o.lane });
        return next(u);
      },
      baselineFailures: 0,
    },
    repo,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    strikesAround: 20,
    watchContract: jest.fn(),
    priceOf: () => ({ kind: 'unavailable', reason: 'never-priced' }),
    quoteNow: async () => new Map(),
    now: () => now,
    ...over,
  };
  const svc = new ChainService(deps);
  return {
    svc, repo, builds, deps,
    advance: (ms: number) => (now += ms),
    setNext: (f: (u: string) => BuildOutcome) => (next = f),
    now: () => now,
  };
}

describe('ChainService', () => {
  it('builds on an Interactive lane when asked, then serves the cached chain fresh for 15 s', async () => {
    const { svc, builds, advance } = service('2026-10-12T10:00:00');
    expect((await svc.chain('nifty', E)).kind).toBe('fresh');
    advance(10_000);
    expect((await svc.chain('NIFTY', E)).kind).toBe('fresh');
    expect(builds).toEqual([{ u: 'NIFTY', lane: 1 }]);
    advance(6_000);
    await svc.chain('NIFTY', E);
    expect(builds).toHaveLength(2);
    expect(svc.status().cacheHits).toBe(1);
  });

  it('a failed build serves the cached chain as stale with its age', async () => {
    const { svc, advance, setNext } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E);
    advance(20_000);
    setNext(() => ({ kind: 'unavailable', reason: 'throttled' }));
    const r = await svc.chain('NIFTY', E);
    expect(r).toEqual({ kind: 'stale', chain: expect.objectContaining({ underlying: 'NIFTY' }), ageMs: 20_000 });
    expect(svc.status().unavailable.throttled).toBe(1);
  });

  it("falls back to today's stored snapshot as stale, and to unavailable with the build's reason", async () => {
    const { svc, repo, setNext, now } = service('2026-10-12T10:00:00');
    setNext(() => ({ kind: 'unavailable', reason: 'busy' }));
    await expect(svc.chain('NIFTY', E)).resolves.toEqual({ kind: 'unavailable', reason: 'busy' });
    repo.chainSnapshots.push(chainAt('NIFTY', now() - 120_000));
    const r = await svc.chain('NIFTY', E);
    expect(r.kind === 'stale' && r.ageMs).toBe(120_000);
  });

  it('no contracts is unavailable: no-contracts, without a build', async () => {
    const { svc, builds } = service('2026-10-12T10:00:00');
    await expect(svc.chain('NOSUCH', E)).resolves.toEqual({ kind: 'unavailable', reason: 'no-contracts' });
    expect(builds).toHaveLength(0);
  });

  it('a closed venue serves the latest snapshot as market-closed while another venue refreshes', async () => {
    const { svc, repo, builds } = service('2026-10-12T16:00:00'); // NSE closed, MCX open
    repo.chainSnapshots.push(chainAt('NIFTY', IST('2026-10-12T15:30:00')));
    const n = await svc.chain('NIFTY', E);
    expect(n.kind).toBe('market-closed');
    expect(n.kind === 'market-closed' && n.chain.at).toBe(IST('2026-10-12T15:30:00'));
    expect((await svc.chain('CRUDEOIL', E)).kind).toBe('fresh');
    expect(builds.map((b) => b.u)).toEqual(['CRUDEOIL']);
  });

  it('a closed market with no cache and no snapshot builds once, stores it, then serves it', async () => {
    const { svc, repo, builds } = service('2026-10-12T20:00:00'); // NSE closed
    const r = await svc.chain('NIFTY', E);
    expect(r.kind).toBe('market-closed');
    await svc.chain('NIFTY', E);
    expect(builds).toHaveLength(1);
    await new Promise((res) => setImmediate(res));
    expect(repo.chainSnapshots).toHaveLength(1);
  });

  it('refreshes screen-watched and held chains every 10 s on the Routine lane, until the screen watch expires', async () => {
    const { svc, builds, advance, repo, now } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E, { screen: true });
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds.map((b) => b.lane)).toEqual([1, 2]);
    advance(121_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(2); // expired, no refresh
    repo.heldInfo.set('NFO:HELD1', { name: 'NIFTY', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'HELD1', symbol: 'NIFTY25000CE' }]);
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(3);
    expect(svc.status().held).toBe(1);
  });

  it('a hot-path consumer (no screen flag) gets a build but no standing refresh', async () => {
    const { svc, builds, advance, now } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E);
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(1);
    expect(svc.status().viewedToday).toBe(0);
  });

  it('merges concurrent builds for the same chain', async () => {
    const { svc, builds } = service('2026-10-12T10:00:00');
    await Promise.all([svc.chain('NIFTY', E), svc.chain('NIFTY', E), svc.chain('NIFTY', E)]);
    expect(builds).toHaveLength(1);
  });

  it('optionLtp watches the contract, answers from the book, else quotes it now', async () => {
    const watchContract = jest.fn();
    const quoteNow = jest.fn(async () => new Map([['NFO:T25000', { kind: 'ok' as const, tick: { token: 'T25000', symbol: 'x', ltp: 130.5, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: new Date() } }]]));
    const { svc } = service('2026-10-12T10:00:00', { watchContract, quoteNow });
    await expect(svc.optionLtp('NIFTY', E, 25000, 'CE')).resolves.toBe(130.5);
    expect(watchContract).toHaveBeenCalledWith({ exchange: 'NFO', token: 'T25000', symbol: 'N25000' });
    await expect(svc.optionLtp('NIFTY', E, 25050, 'CE')).resolves.toBeNull();
  });

  describe('awaiting deadline', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a caller joining a slow in-flight Routine refresh gets stale after 5 s (busy once); the shared build still lands', async () => {
      const h = service('2026-10-12T10:00:00');
      await h.svc.chain('NIFTY', E, { screen: true });
      const fast = h.deps.builder.build;
      h.deps.builder.build = (u, e, o) =>
        new Promise((res) => setTimeout(() => res(fast(u, e, o)), 6_000));
      h.advance(10_000);
      const refresh = h.svc.refreshTick(h.now()); // Routine build, 6 s
      h.advance(6_000); // cache now 16 s old: the caller needs a build and joins the in-flight one
      const pending = h.svc.chain('NIFTY', E);
      let settled: unknown = null;
      void pending.then((r) => (settled = r));
      await jest.advanceTimersByTimeAsync(CHAIN_AWAIT_DEADLINE_MS - 1);
      expect(settled).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: 'stale', chain: expect.objectContaining({ underlying: 'NIFTY' }), ageMs: 16_000 });
      expect(h.svc.status().unavailable.busy).toBe(1);
      await jest.advanceTimersByTimeAsync(1_000); // the shared build completes and is cached
      await refresh;
      expect((await h.svc.chain('NIFTY', E)).kind).toBe('fresh');
      expect(h.builds).toHaveLength(2);
      expect(h.svc.status().unavailable.busy).toBe(1);
    });

    it('a build that never answers is unavailable: busy within 5 s, and a winning build leaves no timer behind', async () => {
      const h = service('2026-10-12T10:00:00');
      await h.svc.chain('NIFTY', E);
      expect(jest.getTimerCount()).toBe(0);
      h.deps.builder.build = () => new Promise(() => undefined);
      const pending = h.svc.chain('NIFTY', '2026-10-20');
      await jest.advanceTimersByTimeAsync(CHAIN_AWAIT_DEADLINE_MS);
      await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'busy' });
    });
  });

  it("does not serve yesterday's cached chain as stale", async () => {
    const { svc, advance, setNext } = service('2026-10-12T15:00:00');
    await svc.chain('NIFTY', E);
    advance(19 * 3600_000); // 2026-10-13 10:00 IST, NSE open
    setNext(() => ({ kind: 'unavailable', reason: 'throttled' }));
    await expect(svc.chain('NIFTY', E)).resolves.toEqual({ kind: 'unavailable', reason: 'throttled' });
  });

  it('a failing closed-market build is memoised for 5 minutes per chain', async () => {
    const { svc, builds, advance, setNext } = service('2026-10-12T20:00:00'); // NSE closed
    setNext(() => ({ kind: 'unavailable', reason: 'throttled' }));
    await expect(svc.chain('NIFTY', E)).resolves.toEqual({ kind: 'unavailable', reason: 'throttled' });
    advance(60_000);
    await expect(svc.chain('NIFTY', E)).resolves.toEqual({ kind: 'unavailable', reason: 'throttled' });
    expect(builds).toHaveLength(1);
    advance(4 * 60_000);
    await svc.chain('NIFTY', E);
    expect(builds).toHaveLength(2);
  });

  it('evicts the least recently used chain, not the oldest inserted', async () => {
    const { svc, builds } = service('2026-10-12T10:00:00', { maxCache: 2 });
    await svc.chain('NIFTY', E);
    await svc.chain('NIFTY', '2026-10-20');
    await svc.chain('NIFTY', E); // hit: E is now the most recently used
    await svc.chain('NIFTY', '2026-10-27'); // evicts 2026-10-20
    expect(builds).toHaveLength(3);
    expect((await svc.chain('NIFTY', E)).kind).toBe('fresh');
    expect(builds).toHaveLength(3);
    await svc.chain('NIFTY', '2026-10-20');
    expect(builds).toHaveLength(4);
  });

  it('overlapping setHeld calls: only the latest one assigns the held set', async () => {
    const { svc, repo } = service('2026-10-12T10:00:00');
    let release!: (v: Array<{ name: string; expiry: string }>) => void;
    const describe = jest
      .spyOn(repo, 'describe')
      .mockImplementationOnce(() => new Promise((res) => (release = res)))
      .mockImplementationOnce(async () => []);
    const first = svc.setHeld([{ exchange: 'NFO', token: 'HELD1', symbol: 'X' }]);
    await svc.setHeld([]);
    release([{ name: 'NIFTY', expiry: E }]);
    await first;
    expect(describe).toHaveBeenCalledTimes(2);
    expect(svc.status().held).toBe(0);
  });

  it('held chains are not refreshed while refreshHeld() is false; screen-watched chains still are', async () => {
    const { svc, repo, builds, advance, now } = service('2026-10-12T10:00:00', { refreshHeld: () => false });
    repo.heldInfo.set('NFO:HELD1', { name: 'CRUDEOIL', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'HELD1', symbol: 'CRUDEOIL6000CE' }]);
    expect(svc.status().held).toBe(1);
    await svc.chain('NIFTY', E, { screen: true });
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds.map((b) => `${b.u}:${b.lane}`)).toEqual(['NIFTY:1', 'NIFTY:2']);
  });
});
