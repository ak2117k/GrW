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
const tracker = { openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()) };
const prisma = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(0) };

describe('MarketHubService', () => {
  it('does nothing when disabled and says why', () => {
    const m = manager();
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, m as any, tracker as any, prisma as any);
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
    );
    const result = svc.onModuleInit();
    expect(result).toBeUndefined();
    expect(m.pin).toHaveBeenCalledWith('owner', []);
    expect(svc.status()).not.toBeNull();
    svc.onModuleDestroy();
  });

  const enabled = (extra: Record<string, unknown> = {}) =>
    config({ 'hub.enabled': true, 'hub.ownerUserId': 'owner', 'hub.slotCap': 50, 'hub.mcxLateClose': '', ...extra });

  it('runs no candle store unless HUB_CANDLES_ENABLED, and never serves charts then', () => {
    const svc = new MarketHubService(enabled({ 'hub.candlesEnabled': false, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any);
    svc.onModuleInit();
    expect(svc.status()?.candles).toBeNull();
    expect(svc.servesCharts()).toBe(false);
    svc.onModuleDestroy();
  });

  it('serves charts only when both candle flags are on', () => {
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any);
    on.onModuleInit();
    expect(on.status()?.candles).not.toBeNull();
    expect(on.servesCharts()).toBe(true);
    on.onModuleDestroy();
    const storeOnly = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': false }) as any, manager() as any, tracker as any, prisma as any);
    storeOnly.onModuleInit();
    expect(storeOnly.servesCharts()).toBe(false);
    storeOnly.onModuleDestroy();
  });

  it('the nightly cron fixes up the previous IST day, and does nothing when candles are off', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-08T00:15:00+05:30'));
    const spy = jest.spyOn(HubEngine.prototype, 'runFixup').mockResolvedValue({ day: '2026-10-07', at: 0, instruments: 0, calls: 0, failures: 0 });
    const off = new MarketHubService(enabled() as any, manager() as any, tracker as any, prisma as any);
    off.onModuleInit();
    await off.nightlyCandleFixup();
    expect(spy).not.toHaveBeenCalled();
    off.onModuleDestroy();
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true }) as any, manager() as any, tracker as any, prisma as any);
    on.onModuleInit();
    await on.nightlyCandleFixup();
    expect(spy).toHaveBeenCalledWith('2026-10-07');
    on.onModuleDestroy();
    spy.mockRestore();
    jest.useRealTimers();
  });

  it('candles() rejects when the hub is not running', async () => {
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, manager() as any, tracker as any, prisma as any);
    svc.onModuleInit();
    await expect(svc.candles({ exchange: 'NSE', token: '1', symbol: 'A' }, '1m', new Date(0), new Date(1))).rejects.toThrow(/not running/);
  });
});
