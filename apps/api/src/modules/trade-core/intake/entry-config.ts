/** O2: the entry switch. Read once at boot (a change is a restart, like every env flag). */
export type EntryMode = 'off' | 'journal' | 'paper';

export interface EntryConfig {
  mode: EntryMode;
  /** Users whose selections may produce entries. Empty = nobody. */
  userIds: ReadonlySet<string>;
}

export const CORE_ENTRY_CONFIG = Symbol('CORE_ENTRY_CONFIG');

/** Anything but `journal` or `paper` is `off` (fail closed). */
export function readEntryConfig(env: Record<string, string | undefined> = process.env): EntryConfig {
  const raw = (env.CORE_ENTRIES_MODE ?? 'off').trim().toLowerCase();
  const mode: EntryMode = raw === 'journal' || raw === 'paper' ? raw : 'off';
  const userIds = new Set((env.CORE_ENTRY_USER_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  return { mode, userIds };
}
