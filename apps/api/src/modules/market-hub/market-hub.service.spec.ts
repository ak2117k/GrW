import { HubEngine } from './hub-engine';
import { MarketHubService } from './market-hub.service';

function config(values: Record<string, unknown>) {
  return { get: jest.fn((k: string) => values[k]) };
}
function manager(pin: jest.Mock = jest.fn(() => new Promise<void>(() => undefined))) {
  return {
    pin,
    unpin: jest.fn().mockResolvedValue(undefined),
    fetchQuotes: jest.fn().mockResolvedValue(new Map()),
    addTickListener: jest.fn(() => () => undefined),
    addStateListener: jest.fn(() => () => undefined),
  };
}
const tracker = {
  openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()),
  openPositionRefsByUser: jest.fn().mockResolvedValue(new Map()),
};
const instruments = { getInstrumentByToken: jest.fn().mockResolvedValue(null), getInstrumentBySymbol: jest.fn().mockResolvedValue(null) };
const prisma = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(0) };
/** JobRunnerService double: runs the job inline (lease held, run recorded). */
const runner = { run: jest.fn((_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()) };

describe('MarketHubService', () => {
  it('does nothing when disabled and says why', () => {
    const m = manager();
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, m as any, tracker as any, prisma as any, runner as any, instruments as any);
    svc.onModuleInit();
    expect(m.pin).not.toHaveBeenCalled();
    expect(svc.status()).toBeNull();
    expect(svc.disabledReason()).toMatch(/MARKET_HUB_ENABLED/);
    expect(svc.price({ exchange: 'NSE', token: '1', symbol: 'A' }, { maxAgeMs: 1 })).toEqual({
      kind: 'unavailable',
      reason: 'no-session',
    });
  });

  it('enabled without an owner reports a reason instead of starting', () => {
    const m = manager();
    const svc = new MarketHubService(
      config({ 'hub.enabled': true, 'hub.ownerUserId': '' }) as any,
      m as any,
      tracker as any,
      prisma as any,
      runner as any,
      instruments as any,
    );
    svc.onModuleInit();
    expect(m.pin).not.toHaveBeenCalled();
    expect(svc.disabledReason()).toMatch(/HUB_OWNER_USER_ID/);
  });

  it('onModuleInit returns without awaiting the broker (boot must not block)', () => {
    const m = manager(); // pin never resolves
    const svc = new MarketHubService(
      config({ 'hub.enabled': true, 'hub.ownerUserId': 'owner', 'hub.slotCap': 50, 'hub.mcxLateClose': '' }) as any,
      m as any,
      tracker as any,
      prisma as any,
      runner as any,
      instruments as any,
    );
    const result = svc.onModuleInit();
    expect(result).toBeUndefined();
    expect(m.pin).toHaveBeenCalledWith('owner', []);
    expect(svc.status()).not.toBeNull();
    svc.onModuleDestroy();
  });

  const enabled = (extra: Record<string, unknown> = {}) =>
    config({ 'hub.enabled': true, 'hub.ownerUserId': 'owner', 'hub.slotCap': 50, 'hub.mcxLateClose': '', ...extra });

  it('hubFor serves only the owner (or system-wide null) and only for a consumer whose flag is on', () => {
    const svc = new MarketHubService(
      enabled({ 'hub.pricesPositions': true, 'hub.pricesTracks': false }) as any,
      manager() as any,
      tracker as any,
      prisma as any,
      runner as any,
      instruments as any,
    );
    svc.onModuleInit();
    expect(svc.hubFor('owner', 'positions')).not.toBeNull();
    expect(svc.hubFor(null, 'positions')).not.toBeNull();
    // Never another user's positions from the owner's session.
    expect(svc.hubFor('someone-else', 'positions')).toBeNull();
    // HUB_PRICES_TRACKS is off: that consumer keeps its legacy path.
    expect(svc.hubFor('owner', 'tracks')).toBeNull();
    expect(svc.hubFor(null, 'tracks')).toBeNull();
    svc.onModuleDestroy();
  });

  it('hubFor is null when the hub is not running, whatever the flags say', () => {
    const flags = { 'hub.pricesPositions': true, 'hub.pricesTracks': true };
    const disabled = new MarketHubService(config({ 'hub.enabled': false, ...flags }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    disabled.onModuleInit();
    expect(disabled.hubFor('owner', 'positions')).toBeNull();
    expect(disabled.hubFor(null, 'tracks')).toBeNull();
    const noOwner = new MarketHubService(config({ 'hub.enabled': true, 'hub.ownerUserId': '', ...flags }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    noOwner.onModuleInit();
    expect(noOwner.hubFor(null, 'tracks')).toBeNull();
    // record() without a running hub is a no-op, never a throw.
    expect(() => disabled.record('tracks', 'hub', 1)).not.toThrow();
  });

  it('the owner hub reads the engine, and record() lands in status().consumers', () => {
    const svc = new MarketHubService(
      enabled({ 'hub.pricesPositions': true, 'hub.pricesTracks': true }) as any,
      manager() as any,
      tracker as any,
      prisma as any,
      runner as any,
      instruments as any,
    );
    svc.onModuleInit();
    const hub = svc.hubFor(null, 'tracks')!;
    const ref = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE' };
    expect(hub.price(ref, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    void hub.watch([ref], 3, 'track:exit', 120_000);
    expect(hub.price(ref, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'never-priced' });
    svc.record('tracks', 'hub', 2);
    svc.record('positions', 'unpriced');
    expect(svc.status()?.consumers.tracks.hub).toBe(2);
    expect(svc.status()?.consumers.positions.unpriced).toBe(1);
    svc.onModuleDestroy();
  });

  it('runs no candle store unless HUB_CANDLES_ENABLED, and never serves charts then', () => {
    const svc = new MarketHubService(enabled({ 'hub.candlesEnabled': false, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    svc.onModuleInit();
    expect(svc.status()?.candles).toBeNull();
    expect(svc.servesCharts()).toBe(false);
    svc.onModuleDestroy();
  });

  it('serves charts only when both candle flags are on', () => {
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    on.onModuleInit();
    expect(on.status()?.candles).not.toBeNull();
    expect(on.servesCharts()).toBe(true);
    on.onModuleDestroy();
    const storeOnly = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': false }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    storeOnly.onModuleInit();
    expect(storeOnly.servesCharts()).toBe(false);
    storeOnly.onModuleDestroy();
  });

  it('the nightly cron fixes up the previous IST day, and does nothing when candles are off', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-08T00:15:00+05:30'));
    const spy = jest.spyOn(HubEngine.prototype, 'runFixup').mockResolvedValue({ day: '2026-10-07', at: 0, instruments: 0, calls: 0, failures: 0 });
    const off = new MarketHubService(enabled() as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    off.onModuleInit();
    await off.nightlyCandleFixup();
    expect(spy).not.toHaveBeenCalled();
    off.onModuleDestroy();
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    on.onModuleInit();
    await on.nightlyCandleFixup();
    expect(spy).toHaveBeenCalledWith('2026-10-07');
    on.onModuleDestroy();
    spy.mockRestore();
    jest.useRealTimers();
  });

  it('the nightly cron goes through the job runner as hub-candle-fixup (leased and recorded)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-08T00:15:00+05:30'));
    const spy = jest.spyOn(HubEngine.prototype, 'runFixup').mockResolvedValue({ day: '2026-10-07', at: 0, instruments: 1, calls: 3, failures: 0 });
    const order: string[] = [];
    const jobs = {
      run: jest.fn(async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => {
        order.push('lease');
        const v = await fn();
        order.push('recorded');
        return v;
      }),
    };
    spy.mockImplementation(async () => {
      order.push('fixup');
      return { day: '2026-10-07', at: 0, instruments: 1, calls: 3, failures: 0 };
    });
    const svc = new MarketHubService(enabled({ 'hub.candlesEnabled': true }) as any, manager() as any, tracker as any, prisma as any, jobs as any, instruments as any);
    svc.onModuleInit();
    await svc.nightlyCandleFixup();
    expect(jobs.run).toHaveBeenCalledWith('hub-candle-fixup', expect.objectContaining({ ttlMs: expect.any(Number) }), expect.any(Function));
    expect(order).toEqual(['lease', 'fixup', 'recorded']);
    // A failed fix-up reaches the runner (recorded FAILED) and is still never thrown at the scheduler.
    spy.mockRejectedValueOnce(new Error('db down'));
    let seen: unknown = null;
    jobs.run.mockImplementationOnce(async (_n, _o, fn) => {
      try {
        return await fn();
      } catch (err) {
        seen = err;
        throw err;
      }
    });
    await expect(svc.nightlyCandleFixup()).resolves.toBeUndefined();
    expect((seen as Error)?.message).toBe('db down');
    svc.onModuleDestroy();
    spy.mockRestore();
    jest.useRealTimers();
  });

  it('candles() rejects when the hub is not running', async () => {
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    svc.onModuleInit();
    await expect(svc.candles({ exchange: 'NSE', token: '1', symbol: 'A' }, '1m', new Date(0), new Date(1))).rejects.toThrow(/not running/);
  });

  it('watches the owner’s positions with their real symbols, and an index option’s underlying at priority 1', async () => {
    const start = jest.spyOn(HubEngine.prototype, 'start').mockResolvedValue(undefined);
    const setPositions = jest.spyOn(HubEngine.prototype, 'setPositions').mockResolvedValue(undefined);
    const positions = {
      openTrackerRefsByUser: jest.fn(),
      openPositionRefsByUser: jest.fn().mockResolvedValue(
        new Map([
          [
            'owner',
            [
              { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
              { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
              { exchange: 'CDS', token: '1', symbol: 'USDINR26OCTFUT' }, // not a hub exchange
            ],
          ],
          ['someone-else', [{ exchange: 'NFO', token: '99', symbol: 'BANKNIFTY26OCT52000PE' }]],
        ]),
      ),
    };
    const lookups = { getInstrumentByToken: jest.fn().mockResolvedValue({ name: 'NIFTY' }), getInstrumentBySymbol: jest.fn() };
    const svc = new MarketHubService(enabled() as any, manager() as any, positions as any, prisma as any, runner as any, lookups as any);
    svc.onModuleInit();
    await new Promise((r) => setImmediate(r));
    expect(setPositions).toHaveBeenCalledWith(
      [
        { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
        { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
      ],
      [{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }],
    );
    // The contract is looked up WITH its exchange; an index needs no cash row; cash has no underlying.
    expect(lookups.getInstrumentByToken).toHaveBeenCalledTimes(1);
    expect(lookups.getInstrumentByToken).toHaveBeenCalledWith('35001', 'NFO');
    expect(lookups.getInstrumentBySymbol).not.toHaveBeenCalled();
    svc.onModuleDestroy();
    start.mockRestore();
    setPositions.mockRestore();
  });

  it('a failed underlying lookup still watches the position, and is retried on the next refresh', async () => {
    const start = jest.spyOn(HubEngine.prototype, 'start').mockResolvedValue(undefined);
    const setPositions = jest.spyOn(HubEngine.prototype, 'setPositions').mockResolvedValue(undefined);
    const positions = {
      openTrackerRefsByUser: jest.fn(),
      openPositionRefsByUser: jest.fn().mockResolvedValue(new Map([['owner', [{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }]]])),
    };
    const lookups = {
      getInstrumentByToken: jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ name: 'NIFTY' }),
      getInstrumentBySymbol: jest.fn(),
    };
    const svc = new MarketHubService(enabled() as any, manager() as any, positions as any, prisma as any, runner as any, lookups as any);
    svc.onModuleInit();
    await new Promise((r) => setImmediate(r));
    expect(setPositions).toHaveBeenLastCalledWith([{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }], []);
    // White-box: refreshPositions runs from a 60 s timer; call it directly for the retry.
    await (svc as unknown as { refreshPositions(owner: string): Promise<void> }).refreshPositions('owner');
    expect(setPositions).toHaveBeenLastCalledWith(
      [{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }],
      [{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }],
    );
    svc.onModuleDestroy();
    start.mockRestore();
    setPositions.mockRestore();
  });
});
