import { AsyncLocalStorage } from 'node:async_hooks';
import { NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import type { PositionPatch } from './lifecycle.types';
import type { CorePositionRepository } from './repositories/core-position.repository';
import { CoreRiskStateProvider } from './core-risk-state.provider';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

/**
 * The memory repository behind the Prisma tenant extension (TENANT_MODELS has CorePosition):
 * with a non-admin tenant in force, every query sees only that user's rows; withoutTenant
 * lifts it (the CoreKillSwitchReader pattern).
 */
function tenantScoped(m: CorePositionRepository, tenant: TenantContextService, cls: ClsService): CorePositionRepository {
  const scope = (): string | undefined => tenant.get()?.userId;
  const allowed = (userId: string): boolean => scope() === undefined || scope() === userId;
  return {
    ...m,
    findByIntent: async (id: string) => {
      const p = await m.findByIntent(id);
      return p && allowed(p.userId) ? p : null;
    },
    findForUser: async (userId: string, id: string) => (allowed(userId) ? m.findForUser(userId, id) : null),
    listActive: async () => (await m.listActive()).filter((p) => allowed(p.userId)),
    listActiveUserIds: async () => (await m.listActiveUserIds()).filter(allowed),
    listForUser: async (userId: string, since: Date | null) => (allowed(userId) ? m.listForUser(userId, since) : []),
    update: async (userId: string, id: string, v: number, patch: PositionPatch) => (allowed(userId) ? m.update(userId, id, v, patch) : null),
    withoutTenant: <T>(fn: () => T): T => (cls.isActive() ? tenant.runWithoutTenant(fn) : fn()),
  } as unknown as CorePositionRepository;
}

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe("tenant isolation (spec §10: user A's alerts, limits, kill switch and positions never affect user B)", () => {
  it("A's stop, A's exit-all and A's kill switch never touch B's position on the same instrument", async () => {
    const h = lifecycleHarness();
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B', stopPrice: 480 }));
    await h.price(500);
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'A only');
    h.killOn.add('user_A');
    await h.sweep();
    await h.price(499);
    expect(h.positions.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'CLOSED' });
    expect(h.positions.rows.find((x) => x.id === b.id)).toMatchObject({ status: 'OPEN', exitReason: null });
    expect(h.ordersOf(b.id).map((o) => o.purpose)).toEqual(['ENTRY']);
    const provider = new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle);
    expect((await provider.liveState('user_B', new Date())).openPositions.map((x) => x.positionId)).toEqual([b.id]);
    expect((await h.lifecycle.positionsFor('user_B', null)).map((x) => x.id)).toEqual([b.id]);
    await expect(h.lifecycle.requestExit('user_B', a.id, 'MANUAL', 'not mine')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.lifecycle.proposeStop('user_A', b.id, 499, 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a kill switch in A's request before the first sweep recovers EVERY user's positions, not only A's (review fix 1)", async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const tenant = new TenantContextService(cls);
    const h = lifecycleHarness({ repo: (m) => tenantScoped(m, tenant, cls) });
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    const svc = h.restart(); // nothing loaded yet: the first sweep has not run
    const r = await cls.run(async () => {
      tenant.set({ userId: 'user_A', role: 'USER' });
      return svc.exitAll('user_A', 'KILL_SWITCH', 'stop everything');
    });
    await h.settle();
    expect(r).toEqual({ exitsRequested: 1 });
    expect(svc.activeCount()).toBe(2);
    expect(h.hub.watches.filter((w) => w.owner === `core:${b.id}`)).toHaveLength(2); // the first service's and this one's
    await h.price(480); // B's stop (492.5) is crossed: B was recovered, is watched, and exits
    expect(h.positions.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
    expect(h.positions.rows.find((x) => x.id === b.id)).toMatchObject({ status: 'EXITING', exitReason: 'RECOVERY_STOP' });
  });

  it('a user the hub does not serve: the entry never fills and the position is CANCELLED; the served user fills (drift D7)', async () => {
    const h = lifecycleHarness({ served: ['user_A'] });
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    h.advance(30_001);
    await h.sweep();
    expect(h.positions.rows.find((x) => x.id === a.id)?.status).toBe('OPEN');
    expect(h.positions.rows.find((x) => x.id === b.id)?.status).toBe('CANCELLED');
  });
});
