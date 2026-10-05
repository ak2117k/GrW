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

describe('MarketHubService', () => {
  it('does nothing when disabled and says why', () => {
    const m = manager();
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, m as any, tracker as any);
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
    );
    const result = svc.onModuleInit();
    expect(result).toBeUndefined();
    expect(m.pin).toHaveBeenCalledWith('owner', []);
    expect(svc.status()).not.toBeNull();
    svc.onModuleDestroy();
  });
});
