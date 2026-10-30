/**
 * ENTRY_ENGINE=off|observe|paper (default observe).
 *  - off: the cron does nothing.
 *  - observe: every evaluation is recorded in entry_engine_decisions; nothing is opened.
 *  - paper: as observe, and an ENTER that passes the cooldowns opens a PAPER trade (isPaper: true,
 *    strategy ENGINE_ENTRY). There is no live mode: this module never reaches broker order code.
 * Pure parse, never throws: anything unrecognised falls back to observe (the safe default).
 */
export type EntryEngineMode = 'off' | 'observe' | 'paper';

export interface EntryEngineConfig {
  mode: EntryEngineMode;
  problems: string[];
}

export const ENTRY_ENGINE_CONFIG = Symbol('ENTRY_ENGINE_CONFIG');

export function parseEntryEngineConfig(env: Record<string, string | undefined>): EntryEngineConfig {
  const raw = String(env.ENTRY_ENGINE ?? '').trim().toLowerCase();
  if (raw === '') return { mode: 'observe', problems: [] };
  if (raw === 'off' || raw === 'observe' || raw === 'paper') return { mode: raw, problems: [] };
  return { mode: 'observe', problems: [`ENTRY_ENGINE=${env.ENTRY_ENGINE} is not off|observe|paper — using observe`] };
}

/** Trade.strategy / source / tags of an engine paper trade. */
export const ENGINE_ENTRY_STRATEGY = 'ENGINE_ENTRY';
export const ENGINE_ENTRY_SOURCE = 'entry-engine / paper';
export const ENGINE_ENTRY_TAG = 'entry-engine';
export const ENGINE_UNDERLYING_TAG = 'underlying:';
