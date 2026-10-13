/** O2: the entry switch. Read once at boot (a change is a restart, like every env flag). */
export type EntryMode = 'off' | 'journal' | 'paper';

export interface EntryConfig {
  mode: EntryMode;
  /** Users whose selections may produce entries. Empty = nobody. */
  userIds: ReadonlySet<string>;
  /** An alert older than this (since it was stored) never opens: STALE_ALERT (review fix 2). */
  maxAlertAgeMs: number;
}

/** CORE_ENTRY_MAX_ALERT_AGE_SEC default. */
export const DEFAULT_MAX_ALERT_AGE_MS = 180_000;

export const CORE_ENTRY_CONFIG = Symbol('CORE_ENTRY_CONFIG');

/** Anything but `journal` or `paper` is `off` (fail closed). */
export function readEntryConfig(env: Record<string, string | undefined> = process.env): EntryConfig {
  const raw = (env.CORE_ENTRIES_MODE ?? 'off').trim().toLowerCase();
  const mode: EntryMode = raw === 'journal' || raw === 'paper' ? raw : 'off';
  const userIds = new Set((env.CORE_ENTRY_USER_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  const ageSec = Number((env.CORE_ENTRY_MAX_ALERT_AGE_SEC ?? '').trim());
  const maxAlertAgeMs = Number.isFinite(ageSec) && ageSec > 0 ? Math.round(ageSec * 1000) : DEFAULT_MAX_ALERT_AGE_MS;
  return { mode, userIds, maxAlertAgeMs };
}
