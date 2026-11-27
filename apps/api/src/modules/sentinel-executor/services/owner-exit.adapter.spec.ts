import { Logger } from '@nestjs/common';
import { EXIT_AUTHORITY_ACTOR_EMAIL, ManualOwnerExit } from './owner-exit.adapter';

const NOW = new Date('2026-11-27T09:40:00Z');

function make(env: Record<string, string | undefined>) {
  const manual = { request: jest.fn(async () => ({ row: { verdictId: 'man_trk_1' }, started: true, done: Promise.resolve(null) })) };
  return { manual, exit: new ManualOwnerExit(manual as never, () => env) };
}

describe('ManualOwnerExit (OWNER_EXIT for the exit authority)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('places the exit through ManualExitService.request as the owner (ADMIN, exit-authority@grw) with the reason', async () => {
    const { manual, exit } = make({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP HARD_LOSS: X', NOW)).resolves.toBe('man_trk_1');
    expect(manual.request).toHaveBeenCalledWith({ userId: 'owner', role: 'ADMIN', email: EXIT_AUTHORITY_ACTOR_EMAIL }, 'trk', { now: NOW, reason: 'BACKSTOP HARD_LOSS: X' });
    expect(EXIT_AUTHORITY_ACTOR_EMAIL).toBe('exit-authority@grw');
  });

  it('an attempt already working is reported, not re-sent', async () => {
    const { manual, exit } = make({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    manual.request.mockResolvedValueOnce({ row: { verdictId: 'man_trk_1' }, started: false, done: Promise.resolve(null) });
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: X')).resolves.toBe('man_trk_1 (already working)');
  });

  it.each([
    ['user not in AI_AUTO_EXIT_USER_IDS', { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'someone-else' }],
    ['AI auto-exit disabled', { AI_AUTO_EXIT_ENABLED: 'false', AI_AUTO_EXIT_USER_IDS: 'owner' }],
  ])('a BACKSTOP (deadline / hard loss) is refused for an account the executor does not act for: %s', async (_n, env) => {
    const { manual, exit } = make(env);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP DEADLINE: CARRY')).rejects.toThrow(/BACKSTOP DEADLINE refused for owner: not in the AI auto-exit/);
    await expect(exit.exitAsOwner('owner', 'trk', 'BACKSTOP HARD_LOSS: x')).rejects.toThrow(/AI_AUTO_EXIT_USER_IDS/);
    expect(manual.request).not.toHaveBeenCalled();
  });

  it.each(['OWNER via Telegram', 'SUPREME_EXIT (final): supreme asks EXIT'])('"%s" is not restricted by the allow-list (as today: owner button / desk manager)', async (reason) => {
    const { manual, exit } = make({ AI_AUTO_EXIT_ENABLED: 'false' });
    await exit.exitAsOwner('owner', 'trk', reason);
    expect(manual.request).toHaveBeenCalledTimes(1);
  });
});
