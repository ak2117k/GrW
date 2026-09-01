import { InstrumentService, InstrumentRecord } from './instrument.service';

/**
 * These tests exist because of a production outage, not a refactor.
 *
 * `onModuleInit` awaited a full-table load of the `instruments` cache. Nest
 * awaits every `onModuleInit` before `app.listen()`, so that load sat directly
 * in front of the port bind — and Render fails a deploy whose health check path
 * never answers. The service was not slow; it never began serving.
 *
 * The load itself asked for every active instrument in one result set. That was
 * survivable while the table held a few thousand cash equities. Since the master
 * refresh began storing every live derivative contract (each strike of each
 * unexpired NFO/MCX/BFO/CDS expiry), it is orders of magnitude larger, and
 * materialising it in one round trip exhausted memory.
 *
 * So there are two independent requirements here, and BOTH must hold: the boot
 * hook must not block the port, and the load must be bounded no matter how large
 * the table grows.
 */
describe('InstrumentService cache load', () => {
  const row = (n: number): InstrumentRecord => ({
    id: `id-${n}`,
    symbol: `SYM${n}`,
    token: `${n}`,
    name: `Name ${n}`,
    exchange: 'NSE',
    segment: 'NSE',
    lotSize: 1,
    tickSize: 0.05,
    expiry: null,
    strike: null,
    optionType: null,
  });

  const rows = (count: number, offset = 0): InstrumentRecord[] =>
    Array.from({ length: count }, (_, i) => row(offset + i));

  const build = (repository: any) =>
    new InstrumentService(
      repository,
      { get: jest.fn() } as any,
      { setTokenInstrumentId: jest.fn() } as any,
    );

  it('resolves onModuleInit without waiting for the load, so the port can bind', async () => {
    // Every repository call hangs, whichever one the load happens to use. Named
    // methods would let this pass for the wrong reason: a fake missing the
    // method throws, the load's own catch swallows it, and the hook resolves
    // having proven nothing. If the hook awaits the load, this times out —
    // which is precisely what Render recorded as a failed deploy.
    const repository = new Proxy(
      {},
      { get: () => () => new Promise(() => {}) },
    );

    // Asserted as a race rather than on the return value, so this holds for a
    // synchronous hook AND for an async one that merely declines to await the
    // load. What must never pass is a hook that finishes only when the load does.
    const outcome = await Promise.race([
      Promise.resolve(build(repository).onModuleInit()).then(() => 'hook settled'),
      // unref'd: when the hook wins the race this timer is still pending, and a
      // live handle keeps Jest's worker from exiting.
      new Promise((resolve) => {
        setTimeout(() => resolve('hook blocked on the load'), 100).unref();
      }),
    ]);

    expect(outcome).toBe('hook settled');
  });

  it('pages the load in bounded batches rather than materialising the table', async () => {
    const size = InstrumentService.LOAD_PAGE_SIZE;
    const repository = {
      getActiveInstrumentPage: jest
        .fn()
        .mockResolvedValueOnce(rows(size))
        .mockResolvedValueOnce(rows(3, size)),
    };

    const service = build(repository);
    await service.loadCacheFromDatabase();

    // A short final page ends the walk — no extra probe round trip.
    expect(repository.getActiveInstrumentPage).toHaveBeenCalledTimes(2);
    expect(repository.getActiveInstrumentPage).toHaveBeenNthCalledWith(1, size, undefined);
    // The second page continues from the last id of the first, so no row is
    // read twice and none is skipped.
    expect(repository.getActiveInstrumentPage).toHaveBeenNthCalledWith(
      2,
      size,
      `id-${size - 1}`,
    );
    expect(service.getCachedCount()).toBe(size + 3);
  });

  it('caches every page it read, keyed by token and by exchange:token', async () => {
    const repository = {
      getActiveInstrumentPage: jest.fn().mockResolvedValueOnce(rows(2)),
    };

    const service = build(repository);
    await service.loadCacheFromDatabase();

    expect(service.getByExchangeTokenSync('NSE', '1')?.symbol).toBe('SYM1');
    expect(await service.getByToken('0')).toMatchObject({ symbol: 'SYM0' });
  });

  it('keeps the pages it already read when a later page fails', async () => {
    const repository = {
      getActiveInstrumentPage: jest
        .fn()
        .mockResolvedValueOnce(rows(InstrumentService.LOAD_PAGE_SIZE))
        .mockRejectedValueOnce(new Error('connection lost')),
    };

    const service = build(repository);
    // Must not throw: a partial cache still serves lookups, and every miss
    // falls back to a single-row read. Throwing here would take down boot.
    await expect(service.loadCacheFromDatabase()).resolves.toBeUndefined();
    expect(service.getCachedCount()).toBe(InstrumentService.LOAD_PAGE_SIZE);
  });
});
