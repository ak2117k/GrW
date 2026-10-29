import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { BuildOutcome } from './chain-builder';
import type { ChainContract, HubChain } from './chain.types';
import { CHAIN_AWAIT_DEADLINE_MS, ChainService, EXTRA_POLL_MS, type ChainServiceDeps } from './chain-service';

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

  it('snapshot targets are the core list (nearest expiry), held chains and screen-viewed chains', async () => {
    const { svc, repo, now } = service('2026-10-12T10:00:00', { snapshots: { core: ['NIFTY'] } });
    await svc.chain('CRUDEOIL', E, { screen: true });
    repo.heldInfo.set('NFO:H', { name: 'NIFTY', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'H', symbol: 'x' }]);
    const t = await svc.snapshotTargets(now());
    expect(t.map((x) => `${x.underlying}:${x.expiry}`).sort()).toEqual([`CRUDEOIL:${E}`, `NIFTY:${E}`]);
    expect(svc.status().snapshot.enabled).toBe(true);
  });

  it('held chains are snapshot targets even while their 10 s refresh is off (baselines build before the switch)', async () => {
    const { svc, repo, now } = service('2026-10-12T10:00:00', { snapshots: { core: [] }, refreshHeld: () => false });
    repo.heldInfo.set('NFO:H', { name: 'NIFTY', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'H', symbol: 'x' }]);
    expect((await svc.snapshotTargets(now())).map((x) => `${x.underlying}:${x.expiry}`)).toEqual([`NIFTY:${E}`]);
  });

  it('on an expiry day the core list also targets the next expiry (tomorrow needs a baseline); otherwise only the nearest', async () => {
    const NEXT = '2026-10-20';
    const expiryDay = service('2026-10-13T10:00:00', { snapshots: { core: ['NIFTY'] } });
    expiryDay.deps.builder.expiries = async () => [E, NEXT];
    expect((await expiryDay.svc.snapshotTargets(expiryDay.now())).map((x) => `${x.underlying}:${x.expiry}`)).toEqual([`NIFTY:${E}`, `NIFTY:${NEXT}`]);

    const ordinary = service('2026-10-12T10:00:00', { snapshots: { core: ['NIFTY'] } });
    ordinary.deps.builder.expiries = async () => [E, NEXT];
    expect((await ordinary.svc.snapshotTargets(ordinary.now())).map((x) => `${x.underlying}:${x.expiry}`)).toEqual([`NIFTY:${E}`]);

    const lastListed = service('2026-10-13T10:00:00', { snapshots: { core: ['NIFTY'] } });
    lastListed.deps.builder.expiries = async () => [E];
    expect((await lastListed.svc.snapshotTargets(lastListed.now())).map((x) => `${x.underlying}:${x.expiry}`)).toEqual([`NIFTY:${E}`]);
  });

  describe('chain JSON switch', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      [false, 0],
      [true, 1],
    ])('writeChainJson() %s reaches the snapshot job (%i chain snapshots on its first run)', async (on, expected) => {
      const h = service('2026-10-12T10:00:00', { snapshots: { core: ['NIFTY'], writeChainJson: () => on } });
      h.svc.start();
      await jest.advanceTimersByTimeAsync(30_000);
      h.svc.stop();
      expect(h.builds).toHaveLength(1);
      expect(h.repo.chainSnapshots).toHaveLength(expected);
    });
  });

  it('without snapshots deps the job is off and reported disabled', () => {
    const { svc } = service('2026-10-12T10:00:00');
    expect(svc.status().snapshot).toEqual({ enabled: false, rowsToday: 0, failures: 0, lastAt: {} });
    expect(svc.status().futuresOi.enabled).toBe(false);
    expect(svc.status().extra).toEqual({ enabled: false, maxPerDay: 0, today: [], capped: 0 });
  });

  describe('extra (on-demand stock) chain targets', () => {
    const extraService = (start: string, extra: Partial<NonNullable<NonNullable<ChainServiceDeps['snapshots']>['extra']>> = {}) => {
      const h = service(start, { snapshots: { core: ['NIFTY'], extra: { maxPerDay: 2, strikesAround: 5, ...extra } } });
      const listed = new Set(['NIFTY', 'KOTAKBANK', 'CIPLA', 'TVSMOTOR']);
      h.deps.builder.expiries = async (u) => (listed.has(u) ? [E] : []);
      return h;
    };

    it('an admitted stock is a target at the narrow strike count; indices, the core list and unlisted names are refused', async () => {
      const { svc, now } = extraService('2026-10-12T10:00:00');
      await expect(svc.addExtraTarget('kotakbank')).resolves.toBe('added');
      await expect(svc.addExtraTarget('KOTAKBANK')).resolves.toBe('already');
      await expect(svc.addExtraTarget('NIFTY')).resolves.toBe('not-stock');
      await expect(svc.addExtraTarget('SENSEX')).resolves.toBe('not-stock');
      await expect(svc.addExtraTarget('NOSUCH')).resolves.toBe('no-expiry');
      const t = await svc.snapshotTargets(now());
      expect(t).toEqual([
        { underlying: 'NIFTY', expiry: E },
        { underlying: 'KOTAKBANK', expiry: E, strikesAround: 5 },
      ]);
      expect(svc.status().extra).toEqual({ enabled: true, maxPerDay: 2, today: ['KOTAKBANK'], capped: 0 });
    });

    it('caps the day at maxPerDay (first come), counts refusals, and empties at IST midnight', async () => {
      const log = jest.fn();
      const h = extraService('2026-10-12T10:00:00');
      (h.deps as { log?: (m: string) => void }).log = log;
      await h.svc.addExtraTarget('KOTAKBANK');
      await h.svc.addExtraTarget('CIPLA');
      await expect(h.svc.addExtraTarget('TVSMOTOR')).resolves.toBe('capped');
      await expect(h.svc.addExtraTarget('TVSMOTOR')).resolves.toBe('capped');
      expect(h.svc.status().extra).toEqual(expect.objectContaining({ today: ['KOTAKBANK', 'CIPLA'], capped: 2 }));
      h.advance(24 * 3600_000);
      expect(h.svc.extraNames()).toEqual([]);
      await expect(h.svc.addExtraTarget('TVSMOTOR')).resolves.toBe('added');
    });

    it('maxPerDay 0 is off', async () => {
      const { svc } = extraService('2026-10-12T10:00:00', { maxPerDay: 0 });
      await expect(svc.addExtraTarget('KOTAKBANK')).resolves.toBe('off');
      expect(svc.status().extra.enabled).toBe(false);
    });

    it('polls the candidate source at most every 3 minutes, from IST midnight; a failure never breaks the targets', async () => {
      const candidates = jest.fn().mockResolvedValueOnce(['NIFTY', 'CIPLA']).mockRejectedValueOnce(new Error('db down'));
      const h = extraService('2026-10-12T10:00:00', { candidates });
      expect((await h.svc.snapshotTargets(h.now())).map((x) => x.underlying)).toEqual(['NIFTY', 'CIPLA']);
      expect(candidates.mock.calls[0][0]).toEqual(new Date(IST('2026-10-12T00:00:00')));
      h.advance(60_000);
      await h.svc.snapshotTargets(h.now());
      expect(candidates).toHaveBeenCalledTimes(1);
      h.advance(EXTRA_POLL_MS);
      expect((await h.svc.snapshotTargets(h.now())).map((x) => x.underlying)).toEqual(['NIFTY', 'CIPLA']);
      expect(candidates).toHaveBeenCalledTimes(2);
    });

    it('a chain another source already targets keeps the full width', async () => {
      const { svc, now } = extraService('2026-10-12T10:00:00');
      await svc.chain('CIPLA', E, { screen: true });
      await svc.addExtraTarget('CIPLA');
      expect(await svc.snapshotTargets(now())).toEqual([
        { underlying: 'CIPLA', expiry: E },
        { underlying: 'NIFTY', expiry: E },
      ]);
    });

    it('a narrow build is passed its strike count and is not cached for screens', async () => {
      const h = service('2026-10-12T10:00:00');
      const widths: number[] = [];
      h.deps.builder.build = async (u, _e, o) => {
        widths.push(o.strikesAround);
        return { kind: 'ok', chain: chainAt(u, h.now()) };
      };
      await h.svc.freshChain('NIFTY', E, 5);
      await h.svc.freshChain('NIFTY', E, 5);
      await h.svc.freshChain('NIFTY', E);
      await h.svc.freshChain('NIFTY', E, 5);
      expect(widths).toEqual([5, 5, 20]); // the full chain (cached) then serves the narrow request
    });
  });

  describe('futures OI job wiring', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('runs on the snapshot tick even with the option snapshots off, and reports its status', async () => {
      const fut = { instrumentId: 'f1', ref: { exchange: 'NFO' as const, token: 'F1', symbol: 'RELIANCE27OCT26FUT' }, name: 'RELIANCE', expiry: '2026-10-27' };
      const quoteNow = jest.fn(async () => new Map([['NFO:F1', { kind: 'ok' as const, tick: { token: 'F1', symbol: '', ltp: 1400, open: 0, high: 0, low: 0, close: 0, volume: 10, oi: 5000, timestamp: new Date() } }]]));
      jest.setSystemTime(IST('2026-10-12T10:00:00'));
      const h = service('2026-10-12T10:00:00', { quoteNow, futuresOi: { repo: { futures: async () => [fut] } } });
      h.svc.start();
      await jest.advanceTimersByTimeAsync(30_000);
      h.svc.stop();
      expect(h.repo.oiRows).toEqual([expect.objectContaining({ instrumentId: 'f1', oi: 5000, ltp: 1400 })]);
      expect(h.svc.status().futuresOi).toEqual(expect.objectContaining({ enabled: true, contracts: 1, rowsToday: 1, callsToday: 1 }));
    });
  });
});
