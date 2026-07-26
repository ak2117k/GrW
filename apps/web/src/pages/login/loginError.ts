import { AxiosError } from 'axios';

/**
 * Shown when a login/MFA request fails with NO HTTP response — a client timeout,
 * a dropped connection, or a CORS rejection.
 *
 * On this free-tier stack (Render sleeps after ~15 min idle; Neon autosuspends)
 * the first request after an idle spell cold-starts in 30-90s. axios aborts at
 * its timeout with an error that carries no `.response`, exactly like a genuine
 * network drop. Both previously fell through to a misleading "Unable to sign in"
 * — indistinguishable from a wrong password. Naming the real cause tells the
 * user to simply retry (the retry hits a now-warm server and is fast) instead of
 * assuming their credentials are wrong.
 */
export const COLD_START_MESSAGE =
  'The server was waking up and did not respond in time. Please try again — it should be quick now.';

/**
 * Map a login/MFA request error to a user-facing message.
 *
 * Order matters: known HTTP statuses first, then the no-response (cold-start /
 * network) case, then any server-supplied message, then the caller's fallback.
 */
export function classifyLoginError(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    if (status === 401) return 'Invalid email or password.';
    if (status === 429) return 'Too many attempts. Please wait and try again.';

    // No response object => timeout / network drop / CORS. Almost always a cold
    // start on this stack, not a client mistake.
    if (!err.response) return COLD_START_MESSAGE;

    const msg = (err.response.data as { message?: unknown } | undefined)?.message;
    if (typeof msg === 'string') return msg;
    if (Array.isArray(msg) && msg.length) return String(msg[0]);
  }
  return fallback;
}
