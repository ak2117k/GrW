import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreRiskLimit, type CoreRiskLimitDefault } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { toStorage, type StoredLimitValue } from '../limits/limit-keys';
import { createCoreSessionClock } from '../ports';
import type { CoreRiskLimitRepository, NewLimitRow } from '../repositories/core-risk-limit.repository';
import { limitsFixture, NOW } from '../testing/risk-fixtures';
import { CoreRiskDefaultsService } from './core-risk-defaults.service';
import { CoreRiskLimitService } from './core-risk-limit.service';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };

/** One in-memory store behind both services, so "future seeds" can be observed. */
class Store {
  limits: CoreRiskLimit[] = [];
  defaults: CoreRiskLimitDefault[] = limitsFixture().map((l) => ({
    key: l.key, scope: l.scope, ...toStorage(l.key, l.value), note: 'seed', updatedBy: null, updatedAt: NOW,
  }));
  appendCalls = 0;
  private seq = 0;

  async listDefaults() { return this.defaults; }
  async upsertDefault(key: string, scope: string, value: StoredLimitValue, note: string, updatedBy: string, now: Date) {
    const row = { key, scope, ...value, note, updatedBy, updatedAt: now };
    this.defaults = [...this.defaults.filter((d) => !(d.key === key && d.scope === scope)), row];
    return row;
  }
  async listForUser(userId: string) { return this.limits.filter((r) => r.userId === userId); }
  async listForPair(userId: string, key: string, scope: string) { return this.limits.filter((r) => r.userId === userId && r.key === key && r.scope === scope); }
  async pairsForUser(userId: string) { return new Set((await this.listForUser(userId)).map((r) => `${r.key}@${r.scope}`)); }
  async settingsForSeed() { return { settings: null, from: null }; }
  async append(): Promise<CoreRiskLimit> { this.appendCalls += 1; throw new Error('not used here'); }
  async appendIfMissing(userId: string, rows: NewLimitRow[], now: Date) {
    const present = await this.pairsForUser(userId);
    return rows.filter((r) => !present.has(`${r.key}@${r.scope}`)).map((r) => {
      this.seq += 1;
      const row = { id: `lim_${this.seq}`, userId, ...r, createdAt: new Date(now.getTime() + this.seq) } as CoreRiskLimit;
      this.limits.push(row);
      return row;
    });
  }
}

function setup() {
  const store = new Store();
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const repo = store as unknown as CoreRiskLimitRepository;
  const defaults = new CoreRiskDefaultsService(repo, audit as unknown as AuditService);
  const limits = new CoreRiskLimitService(repo, audit as unknown as AuditService, createCoreSessionClock() as SessionClock);
  return { store, audit, defaults, limits };
}

describe('CoreRiskDefaultsService (decision 20)', () => {
  it('lists every (key, scope) in display order, with null for a missing row', async () => {
    const { store, defaults } = setup();
    store.defaults = store.defaults.filter((d) => d.key !== 'maxTradesPerDay');
    const views = await defaults.list();
    expect(views).toHaveLength(21);
    expect(views[0]).toEqual({ key: 'maxDailyLoss', scope: 'ALL', kind: 'rupees', tighter: 'lower', value: 5000, note: 'seed', updatedBy: null, updatedAt: NOW.toISOString() });
    expect(views.find((v) => v.key === 'maxTradesPerDay')).toMatchObject({ value: null, note: null, updatedAt: null });
  });

  it('the owner changes a default at once; the reason becomes its note; it is audited', async () => {
    const { audit, defaults } = setup();
    const v = await defaults.change(OWNER, { key: 'squareOffTime', scope: 'CASH_INTRADAY', value: '15:20', reason: '  earlier exit  ' }, NOW);
    expect(v).toEqual({ key: 'squareOffTime', scope: 'CASH_INTRADAY', kind: 'hhmm', tighter: 'earlier', value: '15:20', note: 'earlier exit', updatedBy: 'usr_owner', updatedAt: NOW.toISOString() });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_RISK_DEFAULT_CHANGED',
      userId: 'usr_owner',
      target: 'core_risk_limit_default:squareOffTime@CASH_INTRADAY',
      meta: { key: 'squareOffTime', scope: 'CASH_INTRADAY', from: '15:15', to: '15:20', reason: 'earlier exit' },
    });
  });

  it('a changed default seeds future users only; existing user rows are never rewritten', async () => {
    const { store, defaults, limits } = setup();
    const before = await limits.list('user_A', NOW);
    expect(before.find((l) => l.key === 'maxTradesPerDay')?.value).toBe(20);
    const rowsBefore = JSON.stringify(store.limits);
    await defaults.change(OWNER, { key: 'maxTradesPerDay', scope: 'ALL', value: 12, reason: 'fewer trades' }, NOW);
    expect(JSON.stringify(store.limits)).toBe(rowsBefore);
    expect(store.appendCalls).toBe(0);
    expect((await limits.list('user_A', NOW)).find((l) => l.key === 'maxTradesPerDay')?.value).toBe(20);
    expect((await limits.list('user_B', NOW)).find((l) => l.key === 'maxTradesPerDay')).toMatchObject({
      value: 12, source: 'DEFAULT', reason: 'default — please review (fewer trades)',
    });
  });

  it('only the owner may change a default, even if the route guard were bypassed; nothing is written', async () => {
    const { store, audit, defaults } = setup();
    const snapshot = JSON.stringify(store.defaults);
    await expect(defaults.change(USER, { key: 'maxTradesPerDay', scope: 'ALL', value: 99, reason: 'mine' }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify(store.defaults)).toBe(snapshot);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('an unknown pair is 404 and a bad value is 422', async () => {
    const { defaults } = setup();
    await expect(defaults.change(OWNER, { key: 'nope', scope: 'ALL', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(defaults.change(OWNER, { key: 'maxDailyLoss', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(defaults.change(OWNER, { key: 'mtfMaxLeverage', scope: 'MTF', value: 0.5, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('CoreRiskLimitRepository.upsertDefault', () => {
  it('touches only core_risk_limit_defaults, keyed by (key, scope)', async () => {
    const { CoreRiskLimitRepository } = await import('../repositories/core-risk-limit.repository');
    const prisma = {
      coreRiskLimitDefault: { upsert: jest.fn().mockResolvedValue({}) },
      coreRiskLimit: new Proxy({}, { get: () => { throw new Error('core_risk_limits must not be touched'); } }),
    };
    const value = { numValue: new Prisma.Decimal('12'), textValue: null };
    await new CoreRiskLimitRepository(prisma as never).upsertDefault('maxTradesPerDay', 'ALL', value, 'fewer', 'usr_owner', NOW);
    expect(prisma.coreRiskLimitDefault.upsert).toHaveBeenCalledWith({
      where: { key_scope: { key: 'maxTradesPerDay', scope: 'ALL' } },
      create: { key: 'maxTradesPerDay', scope: 'ALL', ...value, note: 'fewer', updatedBy: 'usr_owner', updatedAt: NOW },
      update: { ...value, note: 'fewer', updatedBy: 'usr_owner', updatedAt: NOW },
    });
  });
});
