// apps/api/src/modules/mbm/mbm.config.ts
// MBM M2 flags (docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §4). Parsed in ONE place.

export type MbmMode = 'off' | 'observe' | 'on';

export interface MbmConfig {
  /** off: nothing runs, the client answers `absent`. observe (M2): bars refresh + proxy. on: reserved. */
  mode: MbmMode;
  /** Upper-cased, de-duplicated instrument list (MBM_INSTRUMENTS, default NIFTY). */
  instruments: string[];
  /** MBM service base URL without a trailing slash (MBM_URL, default http://mbm:5100). */
  url: string;
  /** The owner whose OWN Angel session fetches the 1m bars (MBM_FEED_USER_ID, else first AI_AUTO_EXIT_USER_IDS). */
  feedUserId: string | null;
  /**
   * M3 trade-core entry gate `market-behaviour` (MBM_ENTRY_GATE, default off). observe: the gate always
   * passes and records what it would have done; on: a regime the strategy version skips fails the gate.
   * Inert whenever `mode` is off: read it through `mbmEntryGateMode`.
   */
  entryGate: MbmMode;
  /** Human-readable fallbacks taken while parsing; logged once at boot. */
  problems: string[];
}

export const MBM_CONFIG = Symbol('MBM_CONFIG');

const MODES: readonly MbmMode[] = ['off', 'observe', 'on'];
const DEFAULT_URL = 'http://mbm:5100';

const csv = (raw: string | undefined): string[] =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function parseMbmConfig(env: NodeJS.ProcessEnv): MbmConfig {
  const problems: string[] = [];

  const rawMode = (env.MBM_ENABLED ?? '').trim().toLowerCase();
  let mode: MbmMode = 'off';
  if ((MODES as readonly string[]).includes(rawMode)) mode = rawMode as MbmMode;
  else if (rawMode !== '') problems.push(`MBM_ENABLED=${rawMode} is not off|observe|on — using off`);

  let instruments = [...new Set(csv(env.MBM_INSTRUMENTS).map((s) => s.toUpperCase()))];
  if (instruments.length === 0) instruments = ['NIFTY'];

  let url = (env.MBM_URL ?? '').trim().replace(/\/+$/, '');
  if (url === '') url = DEFAULT_URL;
  else if (!/^https?:\/\//i.test(url)) {
    problems.push(`MBM_URL=${url} is not an http(s) URL — using ${DEFAULT_URL}`);
    url = DEFAULT_URL;
  }

  const rawGate = (env.MBM_ENTRY_GATE ?? '').trim().toLowerCase();
  let entryGate: MbmMode = 'off';
  if ((MODES as readonly string[]).includes(rawGate)) entryGate = rawGate as MbmMode;
  else if (rawGate !== '') problems.push(`MBM_ENTRY_GATE=${rawGate} is not off|observe|on — using off`);

  const feedUserId = (env.MBM_FEED_USER_ID ?? '').trim() || csv(env.AI_AUTO_EXIT_USER_IDS)[0] || null;
  if (mode !== 'off' && !feedUserId) {
    problems.push('no MBM_FEED_USER_ID and AI_AUTO_EXIT_USER_IDS is empty — the bar refresher will not run');
  }

  return { mode, instruments, url, feedUserId, entryGate, problems };
}

/** The entry gate's effective mode: MBM_ENABLED=off makes every consumer inert (plan M3, global rule). */
export function mbmEntryGateMode(c: Pick<MbmConfig, 'mode' | 'entryGate'> | null | undefined): MbmMode {
  return !c || c.mode === 'off' ? 'off' : c.entryGate;
}

/** The single boot line: `[mbm] mode=… instruments=… url=… feedUser=…`. */
export function mbmBootLine(c: MbmConfig): string {
  return `[mbm] mode=${c.mode} instruments=${c.instruments.join(',')} url=${c.url} feedUser=${c.feedUserId ?? 'none'}`;
}
