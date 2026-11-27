import { Logger } from '@nestjs/common';
import { BackstopRehearsal } from '../../exit-authority/services/escalation-runner.service';
import { EXIT_AUTHORITY_ACTOR_EMAIL, ManualOwnerExit } from './owner-exit.adapter';

const NOW = new Date('2026-11-27T09:40:00Z');
const LIVE = { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_MODE: 'live' };

function make(env: Record<string, string | undefined>) {
  const manual = { request: jest.fn(async (..._a: unknown[]) => ({ row: { verdictId: 'man_trk_1' }, started: true, done: Promise.resolve(null) })) };
  return { manual, exit: new ManualOwnerExit(manual as never, () => env) };
}

describe('ManualOwnerExit (OWNER_EXIT for the exit authority)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('places the exit through ManualExitService.request as the owner (ADMIN, exit-authority@grw) with the reason, not owner-initiated', async () => {
    const { manual, exit } = make(LIVE);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP HARD_LOSS: X', { now: NOW })).resolves.toBe('man_trk_1');
    expect(manual.request).toHaveBeenCalledWith(
      { userId: 'owner', role: 'ADMIN', email: EXIT_AUTHORITY_ACTOR_EMAIL }, 'trk', { now: NOW, reason: 'BACKSTOP HARD_LOSS: X', ownerInitiated: false },
    );
    expect(EXIT_AUTHORITY_ACTOR_EMAIL).toBe('exit-authority@grw');
  });

  it('owner ruling 2026-11-27: ownerInitiated is passed through only when the caller says so (the Telegram Exit / bx tap)', async () => {
    const { manual, exit } = make(LIVE);
    await exit.exitAsOwner('owner', 'trk', 'OWNER via Telegram', { now: NOW, ownerInitiated: true });
    await exit.exitAsOwner('owner', 'trk', 'SUPREME_EXIT (final): x', { now: NOW, ownerInitiated: false });
    await exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: x', { now: NOW });
    expect(manual.request.mock.calls.map((c) => (c[2] as { ownerInitiated: boolean }).ownerInitiated)).toEqual([true, false, false]);
  });

  it('an attempt already working is reported, not re-sent', async () => {
    const { manual, exit } = make(LIVE);
    manual.request.mockResolvedValueOnce({ row: { verdictId: 'man_trk_1' }, started: false, done: Promise.resolve(null) });
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: X')).resolves.toBe('man_trk_1 (already working)');
  });

  it.each([
    ['user not in AI_AUTO_EXIT_USER_IDS', { ...LIVE, AI_AUTO_EXIT_USER_IDS: 'someone-else' }],
    ['AI auto-exit disabled', { ...LIVE, AI_AUTO_EXIT_ENABLED: 'false' }],
  ])('a BACKSTOP (deadline / hard loss) is refused for an account the executor does not act for: %s', async (_n, env) => {
    const { manual, exit } = make(env);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: CARRY')).rejects.toThrow(/BACKSTOP DEADLINE refused for owner: not in the AI auto-exit/);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP HARD_LOSS: x')).rejects.toThrow(/AI_AUTO_EXIT_USER_IDS/);
    expect(manual.request).not.toHaveBeenCalled();
  });

  it.each([
    ['AI_AUTO_EXIT_MODE=dry-run', { ...LIVE, AI_AUTO_EXIT_MODE: 'dry-run' }],
    ['AI_AUTO_EXIT_MODE unset (dry-run default)', { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' }],
  ])('%s: a BACKSTOP is rehearsed (BackstopRehearsal), never sold', async (_n, env) => {
    const { manual, exit } = make(env);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP HARD_LOSS: x')).rejects.toBeInstanceOf(BackstopRehearsal);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: x')).rejects.toThrow(/dry-run: would exit/);
    expect(manual.request).not.toHaveBeenCalled();
  });

  it.each(['OWNER via Telegram', 'SUPREME_EXIT (final): supreme asks EXIT'])('"%s" is not restricted by the allow-list or mode (as today: owner button / desk manager)', async (reason) => {
    const { manual, exit } = make({ AI_AUTO_EXIT_ENABLED: 'false', AI_AUTO_EXIT_MODE: 'dry-run' });
    await exit.exitAsOwner('owner', 'trk', reason);
    expect(manual.request).toHaveBeenCalledTimes(1);
  });
});
