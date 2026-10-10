import { ConflictException } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { createCoreSessionClock, type CoreSquareOffPort } from '../ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../repositories/core-kill-switch.repository';
import { ConcurrentRiskChangeError } from '../repositories/core-risk-limit.repository';
import { NOW } from '../testing/risk-fixtures';
import { CoreKillSwitchService } from './core-kill-switch.service';
import type { SiloSquareOffAdapter } from './silo-square-off.adapter';

const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z');
const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const A = { userId: 'user_A', role: 'USER' };
const B = { userId: 'user_B', role: 'USER' };

/** In-memory stand-in for CoreKillSwitchRepository with the same contract. */
class FakeKillRepo {
  rows: CoreKillSwitch[] = [];
  expectations: Array<string | null | undefined> = [];
  private seq = 0;

  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }

  async append(userId: string, row: NewKillSwitchRow, now: Date, expectNewestId?: string | null) {
    this.expectations.push(expectNewestId);
    const newest = (await this.listForUser(userId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (expectNewestId !== undefined && (newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError('the kill switch');
    this.seq += 1;
    const r = { id: `ks_${this.seq}`, userId, ...row, createdAt: new Date(now.getTime() + this.seq) } as CoreKillSwitch;
    this.rows.push(r);
    return r;
  }
}

function setup(opts: { repo?: FakeKillRepo; clock?: Pick<SessionClock, 'nextOpen'> } = {}) {
  const repo = opts.repo ?? new FakeKillRepo();
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const core = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 0, detail: 'no core orders or positions exist yet (M3/M4 add them)' }) };
  const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
  const service = new CoreKillSwitchService(
    repo as unknown as CoreKillSwitchRepository,
    audit as unknown as AuditService,
    (opts.clock ?? createCoreSessionClock()) as SessionClock,
    core as CoreSquareOffPort,
    silos as unknown as SiloSquareOffAdapter,
  );
  return { repo, audit, core, silos, service };
}

describe('CoreKillSwitchService', () => {
  it('GET is read-only and starts off', async () => {
    const { repo, audit, core, silos, service } = setup();
    expect(await service.get('user_A', NOW)).toEqual({ active: false, since: null, reason: null, setBy: null, pendingRelease: null });
    expect(repo.expectations).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled();
    expect(core.squareOffAll).not.toHaveBeenCalled();
    expect(silos.squareOffAll).not.toHaveBeenCalled();
  });

  it('turning on takes effect now, keeps the reason, runs the cascade and audits both', async () => {
    const { audit, core, silos, service } = setup();
    const r = await service.set(A, { active: true, reason: '  market crash  ' }, NOW);
    expect(r.effectiveFrom).toBe(NOW.toISOString());
    expect(r.state).toEqual({ active: true, since: NOW.toISOString(), reason: 'market crash', setBy: 'user_A', pendingRelease: null });
    expect(r.cascade).toEqual({
      core: { status: 'OK', detail: 'no core orders or positions exist yet (M3/M4 add them) (cancelled 0 orders, requested 0 exits)' },
      silos: [{ target: 'auto-execution', status: 'OK', detail: 'set' }],
    });
    expect(core.squareOffAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'market crash');
    expect(silos.squareOffAll).toHaveBeenCalledWith(A, 'market crash');
    expect(audit.append.mock.calls.map((c) => c[0].action)).toEqual(['CORE_KILL_SWITCH_SET', 'CORE_KILL_SWITCH_CASCADE']);
    expect(audit.append.mock.calls[0][0]).toEqual({
      action: 'CORE_KILL_SWITCH_SET', userId: 'user_A', target: 'core_kill_switch:ks_1',
      meta: { active: true, wasActive: false, effectiveFrom: NOW.toISOString(), reason: 'market crash' },
    });
    expect(audit.append.mock.calls[1][0].meta).toEqual(r.cascade);
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });

  it('turning on skips the concurrency check, so a press is never refused', async () => {
    const { repo, service } = setup();
    repo.rows.push({ id: 'ks_other', userId: 'user_A', active: false, effectiveFrom: NOW, setBy: 'user_A', reason: 'x', createdAt: NOW } as CoreKillSwitch);
    await service.set(A, { active: true, reason: 'stop now' }, NOW);
    expect(repo.expectations).toEqual([undefined]);
  });

  it('a core failure is reported and the silos still run; a throwing adapter marks every silo FAILED', async () => {
    const { core, silos, service } = setup();
    core.squareOffAll.mockRejectedValueOnce(new Error('core down'));
    const r = await service.set(OWNER, { active: true, reason: 'stop' }, NOW);
    expect(r.cascade?.core).toEqual({ status: 'FAILED', detail: 'core down' });
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    silos.squareOffAll.mockRejectedValueOnce(new Error('adapter broke'));
    const again = await service.set(OWNER, { active: true, reason: 'stop again' }, NOW);
    expect(again.cascade?.silos).toHaveLength(6);
    expect(again.cascade?.silos.every((s) => s.status === 'FAILED' && s.detail === 'adapter broke')).toBe(true);
  });

  it('pressing on again runs the cascade again', async () => {
    const { core, silos, service } = setup();
    await service.set(OWNER, { active: true, reason: 'one' }, NOW);
    await service.set(OWNER, { active: true, reason: 'two' }, NOW);
    expect(core.squareOffAll).toHaveBeenCalledTimes(2);
    expect(silos.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('turning off while on waits for the next session open; the switch stays on until then', async () => {
    const { repo, audit, core, service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    const off = await service.set(A, { active: false, reason: 'calm again' }, NOW);
    expect(off.effectiveFrom).toBe(NEXT_OPEN.toISOString());
    expect(off.cascade).toBeNull();
    expect(off.state).toMatchObject({ active: true, reason: 'stop', pendingRelease: { effectiveFrom: NEXT_OPEN.toISOString(), reason: 'calm again' } });
    expect(repo.expectations).toEqual([undefined, 'ks_1']);
    expect(core.squareOffAll).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[audit.append.mock.calls.length - 1][0].meta).toEqual({
      active: false, wasActive: true, effectiveFrom: NEXT_OPEN.toISOString(), reason: 'calm again',
    });
    expect(await service.isActive('user_A', new Date(NEXT_OPEN.getTime() - 1))).toBe(true);
    expect(await service.get('user_A', NEXT_OPEN)).toMatchObject({ active: false, pendingRelease: null, reason: 'calm again' });
  });

  it('turning off while off takes effect now', async () => {
    const { service } = setup();
    const r = await service.set(A, { active: false, reason: 'just checking' }, NOW);
    expect(r).toMatchObject({ effectiveFrom: NOW.toISOString(), cascade: null, state: { active: false, pendingRelease: null } });
  });

  it('turning on after a scheduled release cancels the release', async () => {
    const { service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    await service.set(A, { active: false, reason: 'calm' }, NOW);
    const on = await service.set(A, { active: true, reason: 'not calm' }, NOW);
    expect(on.state.pendingRelease).toBeNull();
    expect(await service.isActive('user_A', NEXT_OPEN)).toBe(true);
  });

  it('survives a restart: a new service over the same store still reads on', async () => {
    const first = setup();
    await first.service.set(A, { active: true, reason: 'stop' }, NOW);
    const second = setup({ repo: first.repo });
    expect(await second.service.isActive('user_A', NOW)).toBe(true);
  });

  it('no known session open: the release is refused (409) and the switch stays on', async () => {
    const { repo, service } = setup({ clock: { nextOpen: () => null } });
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    await expect(service.set(A, { active: false, reason: 'calm' }, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.rows).toHaveLength(1);
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });

  it('a concurrent release is 409', async () => {
    const { repo, service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    jest.spyOn(repo, 'append').mockRejectedValueOnce(new ConcurrentRiskChangeError('the kill switch'));
    await expect(service.set(A, { active: false, reason: 'calm' }, NOW)).rejects.toBeInstanceOf(ConflictException);
  });

  it('user B is never affected by user A’s switch', async () => {
    const { service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    expect(await service.isActive('user_B', NOW)).toBe(false);
    expect((await service.set(B, { active: false, reason: 'mine' }, NOW)).effectiveFrom).toBe(NOW.toISOString());
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });
});
