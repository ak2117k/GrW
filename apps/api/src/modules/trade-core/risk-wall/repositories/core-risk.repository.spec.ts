import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID, TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { CoreKillSwitchRepository } from './core-kill-switch.repository';
import { ConcurrentRiskChangeError, CoreRiskLimitRepository, nextCreatedAt, type NewLimitRow } from './core-risk-limit.repository';

const NOW = new Date('2026-10-12T05:00:00.000Z');
const ms = (n: number) => new Date(NOW.getTime() + n);

function fakeTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    coreRiskLimit: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'lim_new', ...data })),
    },
    coreKillSwitch: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'ks_new', ...data })),
    },
  };
}

function fakePrisma() {
  const tx = fakeTx();
  return {
    tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    coreRiskLimit: { findMany: jest.fn().mockResolvedValue([]) },
    coreRiskLimitDefault: { findMany: jest.fn().mockResolvedValue([]) },
    coreKillSwitch: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    userSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

const row = (over: Partial<NewLimitRow> = {}): NewLimitRow => ({
  key: 'maxDailyLoss', scope: 'ALL', numValue: new Prisma.Decimal('4000'), textValue: null,
  effectiveFrom: NOW, source: 'USER', setBy: 'user_A', reason: 'tighter', ...over,
});

describe('CoreRiskLimitRepository', () => {
  it('every read filters by the caller’s userId', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    await repo.listForPair('user_A', 'maxDailyLoss', 'ALL');
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    prisma.coreRiskLimit.findMany.mockResolvedValueOnce([{ key: 'maxDailyLoss', scope: 'ALL' }]);
    expect(await repo.pairsForUser('user_A')).toEqual(new Set(['maxDailyLoss@ALL']));
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, select: { key: true, scope: true }, distinct: ['key', 'scope'] });
  });

  it('append takes the per-user lock, refuses a stale expectation, and orders createdAt after the newest row', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.tx.coreRiskLimit.findFirst.mockResolvedValueOnce({ id: 'lim_9' }).mockResolvedValueOnce({ createdAt: ms(5) });
    const out = await repo.append('user_A', row(), NOW, 'lim_9');
    const [strings, lockKey] = prisma.tx.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(lockKey).toBe('core_risk_limits:user_A');
    expect(prisma.tx.coreRiskLimit.findFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
    });
    expect(prisma.tx.coreRiskLimit.create).toHaveBeenCalledWith({ data: { ...row(), userId: 'user_A', createdAt: ms(6) } });
    expect(out.id).toBe('lim_new');

    const again = fakePrisma();
    again.tx.coreRiskLimit.findFirst.mockResolvedValueOnce({ id: 'lim_10' });
    const repo2 = new CoreRiskLimitRepository(again as unknown as PrismaService);
    await expect(repo2.append('user_A', row(), NOW, 'lim_9')).rejects.toBeInstanceOf(ConcurrentRiskChangeError);
    expect(again.tx.coreRiskLimit.create).not.toHaveBeenCalled();
  });

  it('appendIfMissing inserts only the pairs the user has no row for, each a millisecond apart', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.tx.coreRiskLimit.findMany.mockResolvedValueOnce([{ key: 'maxDailyLoss', scope: 'ALL' }]);
    const rows = [row({ source: 'DEFAULT' }), row({ key: 'maxTradesPerDay', source: 'DEFAULT' }), row({ key: 'maxRiskPerTrade', source: 'DEFAULT' })];
    const out = await repo.appendIfMissing('user_A', rows, NOW);
    expect(out).toHaveLength(2);
    expect(prisma.tx.coreRiskLimit.create.mock.calls.map((c) => [c[0].data.key, c[0].data.userId, c[0].data.createdAt])).toEqual([
      ['maxTradesPerDay', 'user_A', NOW],
      ['maxRiskPerTrade', 'user_A', ms(1)],
    ]);
    const idle = fakePrisma();
    expect(await new CoreRiskLimitRepository(idle as unknown as PrismaService).appendIfMissing('user_A', [], NOW)).toEqual([]);
    expect(idle.$transaction).not.toHaveBeenCalled();
  });

  it('seeds from the user’s own settings; an ADMIN without one uses the platform row; a USER without one gets none', async () => {
    const own = { maxDailyLoss: 7500, maxCapitalPerTrade: 40000, maxConcurrentPositions: 8 };
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'USER', settings: own });
    expect(await repo.settingsForSeed('user_A')).toEqual({ settings: own, from: 'OWN' });
    expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
      where: { id: 'user_A' },
      select: { role: true, settings: { select: { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true } } },
    });

    prisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN', settings: null });
    prisma.userSettings.findUnique.mockResolvedValueOnce(own);
    expect(await repo.settingsForSeed('usr_owner')).toEqual({ settings: own, from: 'PLATFORM' });
    expect(prisma.userSettings.findUnique).toHaveBeenLastCalledWith({
      where: { userId: SYSTEM_USER_ID }, select: { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true },
    });

    prisma.userSettings.findUnique.mockClear();
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'USER', settings: null });
    expect(await repo.settingsForSeed('user_B')).toEqual({ settings: null, from: null });
    expect(prisma.userSettings.findUnique).not.toHaveBeenCalled();
  });

  it('nextCreatedAt is never before now and always after the newest row', () => {
    expect(nextCreatedAt(null, NOW)).toEqual(NOW);
    expect(nextCreatedAt(ms(-10), NOW)).toEqual(NOW);
    expect(nextCreatedAt(NOW, NOW)).toEqual(ms(1));
    expect(nextCreatedAt(ms(40), NOW)).toEqual(ms(41));
  });
});

describe('CoreKillSwitchRepository', () => {
  it('reads only the caller’s rows', async () => {
    const prisma = fakePrisma();
    await new CoreKillSwitchRepository(prisma as unknown as PrismaService).listForUser('user_A');
    expect(prisma.coreKillSwitch.findMany).toHaveBeenCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  });

  it('turning on appends without a concurrency check; a release with a stale expectation is refused', async () => {
    const on = { active: true, effectiveFrom: NOW, setBy: 'user_A', reason: 'stop' };
    const prisma = fakePrisma();
    prisma.tx.coreKillSwitch.findFirst.mockResolvedValueOnce({ id: 'ks_other', createdAt: ms(3) });
    const repo = new CoreKillSwitchRepository(prisma as unknown as PrismaService);
    await repo.append('user_A', on, NOW);
    expect(prisma.tx.$executeRaw.mock.calls[0][1]).toBe('core_kill_switch:user_A');
    expect(prisma.tx.coreKillSwitch.create).toHaveBeenCalledWith({ data: { ...on, userId: 'user_A', createdAt: ms(4) } });

    const stale = fakePrisma();
    stale.tx.coreKillSwitch.findFirst.mockResolvedValueOnce({ id: 'ks_other', createdAt: ms(3) });
    await expect(
      new CoreKillSwitchRepository(stale as unknown as PrismaService).append('user_A', { ...on, active: false }, NOW, 'ks_mine'),
    ).rejects.toBeInstanceOf(ConcurrentRiskChangeError);
    expect(stale.tx.coreKillSwitch.create).not.toHaveBeenCalled();
  });
});

describe('wiring constants', () => {
  it('the per-user risk models are tenant models; the global defaults are not', () => {
    expect(TENANT_MODELS.has('CoreRiskLimit')).toBe(true);
    expect(TENANT_MODELS.has('CoreKillSwitch')).toBe(true);
    expect(TENANT_MODELS.has('CoreRiskLimitDefault')).toBe(false);
  });

  it('the risk audit actions exist', () => {
    expect(AUDIT_ACTIONS.risk).toEqual({
      CORE_RISK_LIMITS_SEEDED: 'CORE_RISK_LIMITS_SEEDED',
      CORE_RISK_LIMIT_CHANGED: 'CORE_RISK_LIMIT_CHANGED',
      CORE_KILL_SWITCH_SET: 'CORE_KILL_SWITCH_SET',
      CORE_KILL_SWITCH_CASCADE: 'CORE_KILL_SWITCH_CASCADE',
      CORE_RISK_DEFAULT_CHANGED: 'CORE_RISK_DEFAULT_CHANGED',
    });
  });
});
