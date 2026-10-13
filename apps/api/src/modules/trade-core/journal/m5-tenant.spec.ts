import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { m5Harness, SEL_UNGATED } from './testing/m5-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('SP2 M5 tenants (spec §3 tenant scoping, §10 tenant test)', () => {
  it("user A's hit opens A's position; user B (not priced by the hub) is NO_PRICE_SOURCE; journals and blocks never cross", async () => {
    const m = m5Harness({ users: ['user_A', 'user_B'], selections: [SEL_UNGATED('user_A'), SEL_UNGATED('user_B')] });
    const out = await m.intake.process(m.hitAt(500));
    expect(out).toEqual([expect.objectContaining({ kind: 'OPENED' }), expect.objectContaining({ kind: 'SKIPPED', reason: 'NO_PRICE_SOURCE' })]);
    await m.pump();
    expect(m.store.rows.filter((r) => r.userId === 'user_B').map((r) => r.type)).toEqual(['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    await m.journal.recordNow({ type: 'RECON_MISMATCH', userId: 'user_A', at: new Date(), strategyId: null, payload: { check: 'FILLS_VS_ORDER' } });
    expect(await m.reads.reconBlock('user_A')).toEqual({ all: true, strategyIds: [] });
    expect(await m.reads.reconBlock('user_B')).toEqual({ all: false, strategyIds: [] });
    expect(await m.reads.latched('user_B', '2026-10-12')).toBe(false);
  });

  it('a user outside CORE_ENTRY_USER_IDS gets nothing at all', async () => {
    const m = m5Harness({ users: ['user_A'], selections: [SEL_UNGATED('user_B')] });
    expect(await m.intake.process(m.hitAt(500))).toEqual([]);
    expect(m.store.rows).toEqual([]);
  });
});
