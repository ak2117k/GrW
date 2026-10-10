import type { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import type { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { coreEntryAllowed, setCoreKillSwitchReader } from '../kill-gate';
import { CoreKillSwitchReader } from './core-kill-switch.reader';

const T0 = new Date('2026-10-12T05:00:00.000Z');
const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z');
const row = (userId: string, id: string, active: boolean, createdAt: Date, effectiveFrom: Date = createdAt) => ({ id, userId, active, createdAt, effectiveFrom });

function setup(rows: ReturnType<typeof row>[] = [], clsActive = true) {
  const findMany = jest.fn(async ({ where }: { where: { userId?: string } }) => (where.userId ? rows.filter((r) => r.userId === where.userId) : rows));
  const prisma = { coreKillSwitch: { findMany } };
  const tenant = { runWithoutTenant: jest.fn(<T>(fn: () => T) => fn()) };
  const cls = { isActive: jest.fn(() => clsActive) };
  const reader = new CoreKillSwitchReader(
    prisma as unknown as PrismaService,
    tenant as unknown as TenantContextService,
    cls as unknown as ClsService,
  );
  return { findMany, tenant, cls, reader };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
afterEach(() => { jest.useRealTimers(); setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined }); });

describe('CoreKillSwitchReader', () => {
  it('reads one user’s switch with the append-only rule', async () => {
    const { reader } = setup([row('user_A', 'k1', true, new Date(T0.getTime() - 60_000)), row('user_A', 'k2', false, new Date(T0.getTime() - 1000), NEXT_OPEN)]);
    expect(await reader.isOn('user_A')).toBe(true); // the release waits for the next open
    expect(await reader.isOn('user_B')).toBe(false);
  });

  it('a per-user read is not hidden by a different tenant in the CLS store (fails closed, not open)', async () => {
    const rows = [row('user_A', 'k1', true, new Date(T0.getTime() - 1000))];
    // Model the tenant extension: inside a CLS store scoped to another non-ADMIN user,
    // only runWithoutTenant lifts the scoping; a scoped query sees none of user_A's rows.
    let bypassed = false;
    const findMany = jest.fn(async ({ where }: { where: { userId?: string } }) => (bypassed ? rows.filter((r) => r.userId === where.userId) : []));
    const tenant = { runWithoutTenant: jest.fn(<T>(fn: () => T): T => { bypassed = true; try { return fn(); } finally { bypassed = false; } }) };
    const reader = new CoreKillSwitchReader(
      { coreKillSwitch: { findMany } } as unknown as PrismaService,
      tenant as unknown as TenantContextService,
      { isActive: () => true } as unknown as ClsService,
    );
    expect(await reader.isOn('user_A')).toBe(true);
    expect(tenant.runWithoutTenant).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { userId: 'user_A' }, select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true } });
  });

  it('registers with the gate as soon as it is constructed (boot window), before module init', async () => {
    setCoreKillSwitchReader(null);
    setup([]);
    // Allowed: a reader is wired (with none the gate would refuse), and it reads OFF.
    expect(await coreEntryAllowed('auto-execution', { userId: 'usr_owner' })).toBe(true);
    setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000))]);
    expect(await coreEntryAllowed('auto-execution', { userId: 'usr_owner' })).toBe(false); // the newest reader, and it reads ON
  });

  it('the platform answer is any ADMIN’s switch, read without tenant scoping', async () => {
    const { findMany, tenant, reader } = setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000)), row('usr_admin2', 'k2', false, new Date(T0.getTime() - 1000))]);
    expect(await reader.isOnForPlatform()).toBe(true);
    expect(findMany).toHaveBeenCalledWith({ where: { user: { role: 'ADMIN' } }, select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true } });
    expect(tenant.runWithoutTenant).toHaveBeenCalled();
  });

  it('outside a request (no CLS context: crons, pollers, Bull workers) the platform read still succeeds', async () => {
    const { findMany, tenant, reader } = setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000))], false);
    // The real runWithoutTenant calls ClsService.set, which throws without a CLS context.
    tenant.runWithoutTenant.mockImplementation(() => { throw new Error('No CLS context available'); });
    expect(await reader.isOnForPlatform()).toBe(true);
    expect(tenant.runWithoutTenant).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
    reader.onModuleInit();
    reader.invalidate();
    // Refused because the switch is on, not because the read threw: an OFF switch is allowed.
    expect(await coreEntryAllowed('ungated-track')).toBe(false);
    const off = setup([], false);
    off.tenant.runWithoutTenant.mockImplementation(() => { throw new Error('No CLS context available'); });
    off.reader.onModuleInit();
    expect(await coreEntryAllowed('ungated-track')).toBe(true);
  });

  it('caches each answer for at most 5 s, and invalidate drops the cache at once', async () => {
    const { findMany, reader } = setup();
    await reader.isOnForPlatform();
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(T0.getTime() + CoreKillSwitchReader.CACHE_MS));
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(2);
    reader.invalidate();
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(CoreKillSwitchReader.CACHE_MS).toBeLessThanOrEqual(5_000);
  });

  it('a failed read is not cached and reaches the gate as a refusal', async () => {
    const { findMany, reader } = setup();
    findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(reader.isOnForPlatform()).rejects.toThrow('db down');
    reader.onModuleInit();
    findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await coreEntryAllowed('ungated-track')).toBe(false);
    expect(await coreEntryAllowed('ungated-track')).toBe(true);
  });

  it('registers with the gate on module init and unregisters on destroy', async () => {
    const { reader } = setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000))]);
    reader.onModuleInit();
    expect(await coreEntryAllowed('watch-monitor')).toBe(false);
    reader.onModuleDestroy();
    expect(await coreEntryAllowed('watch-monitor')).toBe(false); // no reader: fail closed
  });
});

describe('CoreKillSwitchService clears the reader cache on every change', () => {
  it('turning the switch on invalidates the cache before the cascade runs', async () => {
    const { CoreKillSwitchService } = await import('./core-kill-switch.service');
    const order: string[] = [];
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => order.push('invalidate') });
    const repo = {
      listForUser: async () => [],
      append: async (userId: string, r: { active: boolean; effectiveFrom: Date; setBy: string; reason: string }) => ({ id: 'ks_1', userId, ...r, createdAt: T0 }),
    };
    const core = { squareOffAll: async () => { order.push('core'); return { cancelledOrders: 0, exitsRequested: 0, detail: 'none' }; } };
    const silos = { squareOffAll: async () => { order.push('silos'); return []; } };
    const audit = { append: jest.fn().mockResolvedValue({}) };
    const svc = new CoreKillSwitchService(repo as never, audit as never, { nextOpen: () => NEXT_OPEN } as never, core as never, silos as never);
    await svc.set({ userId: 'usr_owner', role: 'ADMIN' }, { active: true, reason: 'stop' }, T0);
    expect(order).toEqual(['invalidate', 'core', 'silos']);
  });
});
