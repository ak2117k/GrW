import { DEFAULT_CEILINGS, parseDeskManagerConfig } from './desk-manager.config';

describe('parseDeskManagerConfig', () => {
  it('defaults: off, owner caps and guard', () => {
    const c = parseDeskManagerConfig({});
    expect(c.mode).toBe('off');
    expect(c.ownerUserId).toBeNull();
    expect(c).toEqual(expect.objectContaining({ maxEntries: 5, maxExits: 20, maxCalls: 400, busyEveryMin: 3, idleEveryMin: 10, noEntryLastMin: 30, minRewardRisk: 1.2 }));
    expect(c.guard).toEqual({ drawdownRupees: 5000, dayLossRupees: 8000, lossStreak: 3 });
    expect(c.ceilings).toEqual(DEFAULT_CEILINGS);
  });

  it('mode is case-insensitive; paper and unknown are off', () => {
    expect(parseDeskManagerConfig({ DESK_MANAGER: 'LIVE' }).mode).toBe('live');
    expect(parseDeskManagerConfig({ DESK_MANAGER: ' shadow ' }).mode).toBe('shadow');
    expect(parseDeskManagerConfig({ DESK_MANAGER: 'paper' }).mode).toBe('off');
  });

  it('out-of-range numbers fall back', () => {
    const c = parseDeskManagerConfig({ DESK_MANAGER_MAX_ENTRIES: '99', DESK_GUARD_LOSS_STREAK: '0', DESK_MANAGER_MAX_CALLS: 'x' });
    expect(c.maxEntries).toBe(5);
    expect(c.guard.lossStreak).toBe(3);
    expect(c.maxCalls).toBe(400);
  });

  it('ceilings from HARD_LOSS_CEILING_BY_CLASS override the defaults', () => {
    const c = parseDeskManagerConfig({ HARD_LOSS_CEILING_BY_CLASS: 'INDEX_OPT:6000,STOCK_OPT:2500' });
    expect(c.ceilings).toEqual({ ...DEFAULT_CEILINGS, INDEX_OPT: 6000, STOCK_OPT: 2500 });
  });

  it('owner from HUB_OWNER_USER_ID', () => {
    expect(parseDeskManagerConfig({ HUB_OWNER_USER_ID: ' u1 ' }).ownerUserId).toBe('u1');
  });
});
