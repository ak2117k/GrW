/**
 * Liveness rules for the channel listener (fix 2026-11-28). Prod 11-27 21:01 UTC: a ~2 min network
 * outage made GramJS give up its own reconnect; the listener's restart then hung for ~18 h, because
 * GramJS `connect()` RESOLVES (false) on a dead network and every later request waits forever.
 * Nothing alerted. These helpers bound every Telegram call in time and decide when the listener is
 * stalled (any hour: channels post evenings and weekends, MCX runs to 23:30 IST).
 */

/** No successful poll and no live update for this long (while listening) → restart the client. */
export const STALL_MIN_DEFAULT = 3;
/** Stalled (or not listening) this long → one ops alert for the outage. */
export const STALL_ALERT_MIN_DEFAULT = 15;
/** connect() + subscribeUpdates() together (GramJS's own 5 tries take up to ~60 s). */
export const CONNECT_TIMEOUT_MS = 90_000;
/** One poll / re-fetch request. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** One media download (≤ 2 MB). */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Closing a client must never block a restart. */
export const DISCONNECT_TIMEOUT_MS = 10_000;
/** First poll round after every (re)connect fetches this many posts per channel… */
export const CATCHUP_LIMIT = 100;
/** …but beyond the usual newest few it keeps only posts this recent (no old history re-emitted). */
export const CATCHUP_MAX_AGE_MS = 48 * 3_600_000;

export class TelegramTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'TelegramTimeoutError';
  }
}

/** Rejects with TelegramTimeoutError when `p` has not settled in `ms`. The timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TelegramTimeoutError(what, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Minutes from an env value; falls back to `def` when missing / not a positive number. */
export function envMinutes(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface StallInput {
  now: number;
  /** Last successful poll round, live update, or FLOOD_WAIT answer (ms epoch); null = none yet. */
  lastProgressAt: number | null;
  /** When the current client started listening (ms epoch). */
  listeningSince: number | null;
  /** No poll is due before this (FLOOD_WAIT pause) — a pause is not a stall. */
  floodPauseUntil: number;
}

/** How long the listening client has shown no sign of life (ms). */
export function silentForMs(i: StallInput): number {
  const since = Math.max(i.lastProgressAt ?? 0, i.listeningSince ?? 0, i.floodPauseUntil);
  return Math.max(0, i.now - since);
}

/** "02:31 IST" */
export function istHm(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
}

export function durationText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function stalledAlertText(a: { downSince: number; now: number; state: string; lastError: string | null }): string {
  const revoked = a.state === 'revoked';
  return (
    `GrW Telegram reader STALLED: no channel post read for ${durationText(a.now - a.downSince)} (since ${istHm(a.downSince)}; state ${a.state}` +
    `${a.lastError ? `, last error ${a.lastError}` : ''}). ` +
    (revoked
      ? 'The Telegram session is no longer valid: reconnect it in Settings.'
      : 'Restarting the client with backoff; missed posts are caught up when it reconnects.')
  );
}

export function recoveredAlertText(a: { downSince: number; now: number; caughtUp: number }): string {
  return (
    `GrW Telegram reader recovered: posts flowing again after ${durationText(a.now - a.downSince)} (down since ${istHm(a.downSince)}). ` +
    `Caught up ${a.caughtUp} post(s) missed meanwhile.`
  );
}
