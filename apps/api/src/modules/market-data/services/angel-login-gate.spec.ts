import { __setLoginGateClock, TOTP_STEP_MS, withAngelLogin } from './angel-login-gate';

describe('withAngelLogin (prod 2026-10-19: shared + per-user logins of one Angel user collided at boot)', () => {
  let t: number;
  const sleeps: number[] = [];
  beforeEach(() => {
    t = 10 * TOTP_STEP_MS + 5_000; // 5 s into a TOTP step
    sleeps.length = 0;
    __setLoginGateClock({ now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  });
  afterAll(() => __setLoginGateClock(null));

  it('a second login of the same client waits for the NEXT TOTP step', async () => {
    const steps: number[] = [];
    await withAngelLogin('A1', async () => steps.push(Math.floor(t / TOTP_STEP_MS)));
    await withAngelLogin('a1 ', async () => steps.push(Math.floor(t / TOTP_STEP_MS))); // same client, normalised
    expect(steps[1]).toBe(steps[0] + 1);
    expect(sleeps).toHaveLength(1);
  });

  it('concurrent logins of the same client run one at a time, never overlapping', async () => {
    let active = 0; let maxActive = 0;
    const login = async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; };
    await Promise.all([withAngelLogin('A1', login), withAngelLogin('A1', login), withAngelLogin('A1', login)]);
    expect(maxActive).toBe(1);
    expect(sleeps).toHaveLength(2);
  });

  it('different clients are not held up by each other', async () => {
    await withAngelLogin('A1', async () => undefined);
    await withAngelLogin('B2', async () => undefined);
    expect(sleeps).toHaveLength(0);
  });

  it('no wait when the previous login was in an earlier step', async () => {
    await withAngelLogin('A1', async () => undefined);
    t += TOTP_STEP_MS;
    await withAngelLogin('A1', async () => undefined);
    expect(sleeps).toHaveLength(0);
  });

  it('a failed login does not block the next one and its error reaches the caller', async () => {
    await expect(withAngelLogin('A1', async () => { throw new Error('rejected'); })).rejects.toThrow('rejected');
    await expect(withAngelLogin('A1', async () => 'ok')).resolves.toBe('ok');
  });

  it('an empty client code is not gated', async () => {
    await withAngelLogin('', async () => undefined);
    await withAngelLogin(undefined, async () => undefined);
    expect(sleeps).toHaveLength(0);
  });
});
