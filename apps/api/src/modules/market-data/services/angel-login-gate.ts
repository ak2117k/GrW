/**
 * ANGEL LOGIN GATE — one Angel `generateSession` at a time per client code, never
 * two inside the same TOTP window.
 *
 * The shared market-data session (AngelOneAuthService) and the owner's per-user
 * feed session (UserFeedSession) can be the SAME Angel user. At boot both logged
 * in within seconds; prod 2026-10-19 saw the shared login fail all 3 attempts
 * (`Invalid session response: {}`), and on the next boot the per-user login fail
 * instead. A TOTP code is valid for one 30 s step, and the old retry loop's three
 * attempts 2 s apart all reused the SAME code — so a login that collided once
 * collided every time.
 *
 * Process-wide (a module singleton, not DI) so both session kinds share it
 * without plumbing; it holds no secrets — only a client code and a step number.
 */

export const TOTP_STEP_MS = 30_000;
/** Margin past the step boundary so a slightly-behind Angel clock agrees on the new code. */
const STEP_MARGIN_MS = 1_500;

const chains = new Map<string, Promise<unknown>>();
const lastStep = new Map<string, number>();

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
// Under Jest the default wait is instant, so the many specs that log in several
// times stay fast; angel-login-gate.spec.ts injects a clock to test the real timing.
const UNDER_JEST = process.env.JEST_WORKER_ID !== undefined;
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => (UNDER_JEST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms))),
};
let clock: Clock = realClock;

/** Tests only. */
export function __setLoginGateClock(c: Clock | null): void {
  clock = c ?? realClock;
  chains.clear();
  lastStep.clear();
}

const stepOf = (ms: number) => Math.floor(ms / TOTP_STEP_MS);

/**
 * Run `login` (which must compute its TOTP INSIDE the callback) after every
 * earlier login for the same client code has finished, and in a TOTP step no
 * earlier login for that client used. An empty client code is not gated.
 */
export function withAngelLogin<T>(clientId: string | null | undefined, login: () => Promise<T>): Promise<T> {
  const key = String(clientId ?? '').trim().toUpperCase();
  if (!key) return login();
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      const used = lastStep.get(key);
      const now = clock.now();
      if (used !== undefined && stepOf(now) <= used) {
        await clock.sleep((used + 1) * TOTP_STEP_MS - now + STEP_MARGIN_MS);
      }
      lastStep.set(key, stepOf(clock.now()));
      return login();
    });
  chains.set(key, run);
  // Keep the map from growing a settled chain forever.
  void run.finally(() => {
    if (chains.get(key) === run) chains.delete(key);
  }).catch(() => undefined);
  return run;
}
