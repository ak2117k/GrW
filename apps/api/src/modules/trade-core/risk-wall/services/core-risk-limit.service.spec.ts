import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimit, CoreRiskLimitDefault } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { toStorage } from '../limits/limit-keys';
import { createCoreSessionClock } from '../ports';
import {
  ConcurrentRiskChangeError,
  type CoreRiskLimitRepository,
  type NewLimitRow,
  type SettingsForSeed,
} from '../repositories/core-risk-limit.repository';
import { limitsFixture, NOW } from '../testing/risk-fixtures';
import { CoreRiskLimitService, type CoreRiskLimitView } from './core-risk-limit.service';

const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z'); // Tue 09:15 IST, the open after NOW (Mon 10:30 IST)
const DEFAULTS: CoreRiskLimitDefault[] = limitsFixture().map((l) => ({ key: l.key, scope: l.scope, ...toStorage(l.key, l.value), note: 'test default', updatedBy: null, updatedAt: NOW }));

/** In-memory stand-in for CoreRiskLimitRepository with the same contract (filters by userId, strict createdAt). */
class FakeRepo {
  rows: CoreRiskLimit[] = [];
  defaults: CoreRiskLimitDefault[] = DEFAULTS;
  settings: SettingsForSeed = { settings: null, from: null };
  failAppendWith: Error | null = null;
  private seq = 0;

  async listForUser(userId: string) { return this.rows.filter((r) => r.userId === userId); }
  async listForPair(userId: string, key: string, scope: string) { return this.rows.filter((r) => r.userId === userId && r.key === key && r.scope === scope); }
  async pairsForUser(userId: string) { return new Set((await this.listForUser(userId)).map((r) => `${r.key}@${r.scope}`)); }
  async listDefaults() { return this.defaults; }
  async settingsForSeed() { return this.settings; }

  async append(userId: string, row: NewLimitRow, now: Date, expectNewestId: string | null) {
    if (this.failAppendWith) throw this.failAppendWith;
    const pair = await this.listForPair(userId, row.key, row.scope);
    const newest = [...pair].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if ((newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError(row.key);
    return this.insert(userId, row, now);
  }

  async appendIfMissing(userId: string, rows: NewLimitRow[], now: Date) {
    const present = await this.pairsForUser(userId);
    return rows.filter((r) => !present.has(`${r.key}@${r.scope}`)).map((r) => this.insert(userId, r, now));
  }

  private insert(userId: string, row: NewLimitRow, now: Date): CoreRiskLimit {
    this.seq += 1;
    const r = { id: `lim_${this.seq}`, userId, ...row, createdAt: new Date(now.getTime() + this.seq) } as CoreRiskLimit;
    this.rows.push(r);
    return r;
  }
}

function setup(opts: { settings?: SettingsForSeed; defaults?: CoreRiskLimitDefault[]; clock?: Pick<SessionClock, 'nextOpen'> } = {}) {
  const repo = new FakeRepo();
  if (opts.settings) repo.settings = opts.settings;
  if (opts.defaults) repo.defaults = opts.defaults;
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreRiskLimitService(
    repo as unknown as CoreRiskLimitRepository,
    audit as unknown as AuditService,
    (opts.clock ?? createCoreSessionClock()) as SessionClock,
  );
  return { repo, audit, service };
}

const find = (views: CoreRiskLimitView[], id: string) => views.find((v) => `${v.key}@${v.scope}` === id)!;
const OWN = { settings: { maxDailyLoss: 7500, maxCapitalPerTrade: 40000, maxConcurrentPositions: 8 }, from: 'OWN' as const };

describe('CoreRiskLimitService: seeding (plan decision 7)', () => {
  it('seeds every pair once: settings equivalents from the user’s settings, the rest from defaults marked for review', async () => {
    const { repo, audit, service } = setup({ settings: OWN });
    const views = await service.list('user_A', NOW);
    expect(views).toHaveLength(21);
    expect(find(views, 'maxDailyLoss@ALL')).toMatchObject({
      value: 7500, source: 'USER_SETTINGS', needsReview: false, setBy: 'SEED',
      reason: 'copied from your settings (user_settings.maxDailyLoss)', effectiveFrom: NOW.toISOString(), pending: null,
    });
    expect(find(views, 'maxOpenPositions@ALL')).toMatchObject({ value: 8, source: 'USER_SETTINGS' });
    expect(find(views, 'optionsMaxPremiumPerTrade@OPTIONS_BUY')).toMatchObject({ value: 40000, source: 'USER_SETTINGS' });
    expect(find(views, 'maxTradesPerDay@ALL')).toMatchObject({
      kind: 'count', tighter: 'lower', value: 20, source: 'DEFAULT', needsReview: true, reason: 'default — please review (test default)',
    });
    expect(find(views, 'lastEntryTime@OPTIONS_BUY')).toMatchObject({ kind: 'hhmm', tighter: 'earlier', value: '14:30' });
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      action: 'CORE_RISK_LIMITS_SEEDED', userId: 'user_A', target: 'core_risk_limits:user_A', meta: { count: 21, unseeded: [] },
    });
    await service.list('user_A', NOW);
    expect(repo.rows).toHaveLength(21);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('with no settings row every pair comes from the defaults; the platform row is named when used', async () => {
    const none = setup();
    expect(find(await none.service.list('user_B', NOW), 'maxDailyLoss@ALL')).toMatchObject({ value: 5000, source: 'DEFAULT', needsReview: true });
    const platform = setup({ settings: { ...OWN, from: 'PLATFORM' } });
    expect(find(await platform.service.list('usr_owner', NOW), 'maxDailyLoss@ALL').reason).toBe(
      'copied from the platform settings row (user_settings.maxDailyLoss)',
    );
  });

  it('a settings value that does not fit its limit falls back to the default; money rounds to 2 dp', async () => {
    const { service } = setup({ settings: { settings: { maxDailyLoss: 1234.567, maxCapitalPerTrade: -5, maxConcurrentPositions: 2.5 }, from: 'OWN' } });
    const views = await service.list('user_A', NOW);
    expect(find(views, 'maxDailyLoss@ALL')).toMatchObject({ value: 1234.57, source: 'USER_SETTINGS' });
    expect(find(views, 'maxOpenPositions@ALL')).toMatchObject({ value: 5, source: 'DEFAULT' });
    expect(find(views, 'optionsMaxPremiumPerTrade@OPTIONS_BUY')).toMatchObject({ value: 50000, source: 'DEFAULT' });
  });

  it('a pair with neither a setting nor a default stays unset and is reported in the audit', async () => {
    const { audit, service } = setup({ defaults: DEFAULTS.filter((d) => d.key !== 'maxTradesPerDay') });
    const views = await service.list('user_A', NOW);
    expect(find(views, 'maxTradesPerDay@ALL')).toMatchObject({ value: null, source: null, needsReview: false, pending: null });
    expect(audit.append.mock.calls[0][0].meta).toMatchObject({ count: 20, unseeded: ['maxTradesPerDay@ALL'] });
  });
});

describe('CoreRiskLimitService: change (D5)', () => {
  it('a tighter change takes effect now and is audited with from, to, direction and reason', async () => {
    const { audit, service } = setup();
    const r = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: '  bad week  ' }, NOW);
    expect(r).toMatchObject({ direction: 'TIGHTER', effectiveFrom: NOW.toISOString() });
    expect(r.limit).toMatchObject({ value: 4000, source: 'USER', setBy: 'user_A', reason: 'bad week', pending: null, needsReview: false });
    expect(audit.append).toHaveBeenLastCalledWith({
      action: 'CORE_RISK_LIMIT_CHANGED',
      userId: 'user_A',
      target: expect.stringMatching(/^core_risk_limit:lim_\d+$/),
      meta: { key: 'maxDailyLoss', scope: 'ALL', from: '5000.00', to: '4000.00', direction: 'TIGHTER', effectiveFrom: NOW.toISOString(), reason: 'bad week', supersedes: null },
    });
  });

  it('a looser change waits for the next session open, shown as pending until then', async () => {
    const { service } = setup();
    const r = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect(r).toMatchObject({ direction: 'LOOSER', effectiveFrom: NEXT_OPEN.toISOString() });
    expect(r.limit).toMatchObject({ value: 5000, pending: { value: 8000, effectiveFrom: NEXT_OPEN.toISOString(), reason: 'more room' } });
    expect(find(await service.list('user_A', new Date(NEXT_OPEN.getTime() - 1)), 'maxDailyLoss@ALL').value).toBe(5000);
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL')).toMatchObject({ value: 8000, pending: null });
  });

  it('re-entering the value in force cancels a pending loosening', async () => {
    const { audit, service } = setup();
    const loosen = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect(loosen.limit.pending).not.toBeNull();
    const same = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 5000, reason: 'changed my mind' }, NOW);
    expect(same).toMatchObject({ direction: 'SAME', effectiveFrom: NOW.toISOString() });
    expect(same.limit).toMatchObject({ value: 5000, pending: null });
    expect(audit.append.mock.calls[audit.append.mock.calls.length - 1][0].meta.supersedes).toMatch(/^lim_\d+$/);
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL').value).toBe(5000);
  });

  it('a tightening after a pending loosening supersedes it for good', async () => {
    const { service } = setup();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect((await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 3000, reason: 'no' }, NOW)).direction).toBe('TIGHTER');
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL').value).toBe(3000);
  });

  it('a per-vehicle loosening waits for that vehicle’s exchange; an ALL loosening for every core exchange', async () => {
    const nextOpen = jest.fn().mockReturnValue(NEXT_OPEN);
    const { service } = setup({ clock: { nextOpen } });
    await service.change('user_A', { key: 'optionsMaxPremiumPerTrade', scope: 'OPTIONS_BUY', value: 60000, reason: 'r1' }, NOW);
    expect(nextOpen.mock.calls.map((c) => c[0])).toEqual(['NFO']);
    nextOpen.mockClear();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 6000, reason: 'r2' }, NOW);
    expect(nextOpen.mock.calls.map((c) => c[0])).toEqual(['NSE', 'NFO']);
    nextOpen.mockClear();
    await service.change('user_A', { key: 'squareOffTime', scope: 'CASH_INTRADAY', value: '15:10', reason: 'earlier' }, NOW);
    expect(nextOpen).not.toHaveBeenCalled();
  });

  it('no known session open: 409, nothing written', async () => {
    const { repo, audit, service } = setup({ clock: { nextOpen: () => null } });
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 9000, reason: 'r' }, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.rows).toHaveLength(21);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('an unknown key or scope is 404 and a bad value is 422, before anything is written', async () => {
    const { repo, service } = setup();
    await expect(service.change('user_A', { key: 'nope', scope: 'ALL', value: 1, reason: 'r' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'MTF', value: 1, reason: 'r' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: '5000', reason: 'r' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.change('user_A', { key: 'lastEntryTime', scope: 'CASH_INTRADAY', value: '3pm', reason: 'r' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.rows).toHaveLength(0);
  });

  it('a concurrent change to the same limit is 409', async () => {
    const { repo, service } = setup();
    await service.list('user_A', NOW);
    repo.failAppendWith = new ConcurrentRiskChangeError('maxDailyLoss');
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 1000, reason: 'r' }, NOW)).rejects.toBeInstanceOf(ConflictException);
  });

  it('setting a limit that has no usable row is a loosening', async () => {
    const { service } = setup({ defaults: DEFAULTS.filter((d) => d.key !== 'maxTradesPerDay') });
    const r = await service.change('user_A', { key: 'maxTradesPerDay', scope: 'ALL', value: 10, reason: 'set it' }, NOW);
    expect(r).toMatchObject({ direction: 'LOOSER', effectiveFrom: NEXT_OPEN.toISOString() });
    expect(r.limit).toMatchObject({ value: null, pending: { value: 10 } });
  });

  it('one user’s change never shows for another user', async () => {
    const { service } = setup();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: 'mine' }, NOW);
    expect(find(await service.list('user_B', NOW), 'maxDailyLoss@ALL').value).toBe(5000);
  });
});

describe('CoreRiskLimitService: inForce (what the Risk Wall reads)', () => {
  it('returns the canonical value, row id and source of every pair in force, seeding first', async () => {
    const { service } = setup({ settings: OWN });
    const limits = await service.inForce('user_A', NOW);
    expect(limits).toHaveLength(21);
    expect(limits.find((l) => l.key === 'maxDailyLoss')).toEqual({
      key: 'maxDailyLoss', scope: 'ALL', value: '7500.00', rowId: expect.stringMatching(/^lim_/), effectiveFrom: NOW.toISOString(), source: 'USER_SETTINGS',
    });
  });

  it('a malformed newest row in force leaves the pair out (the wall then rejects: fail closed)', async () => {
    const { repo, service } = setup();
    await service.list('user_A', NOW);
    repo.rows.push({
      id: 'lim_bad', userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL', numValue: null, textValue: 'oops',
      effectiveFrom: NOW, source: 'USER', setBy: 'user_A', reason: 'corrupt', createdAt: new Date(NOW.getTime() + 999),
    } as CoreRiskLimit);
    const limits = await service.inForce('user_A', NOW);
    expect(limits.map((l) => l.key)).not.toContain('maxDailyLoss');
    expect(limits).toHaveLength(20);
  });
});
