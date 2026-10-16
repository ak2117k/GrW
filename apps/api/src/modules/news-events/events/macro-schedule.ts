import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { EventImpact, EventScope, MarketEventInput } from '../types';
import type { EiaOverride } from './rule-events';
import { isValidTimeZone, zonedToUtc } from './zoned-time';

export const MACRO_KINDS = ['rbi_mpc', 'fomc', 'us_cpi', 'india_cpi', 'us_nfp', 'opec'] as const;
export type MacroKind = (typeof MACRO_KINDS)[number];
export interface MacroEntry { kind: MacroKind; date: string; localTime: string; tz: string; impact: EventImpact; sourceUrl: string; title?: string }
export interface MarketEventsFile { version: 1; macro: MacroEntry[]; usFederalHolidays: string[]; eiaOverrides: EiaOverride[] }

export const MACRO_META: Readonly<Record<MacroKind, { key: string; scope: EventScope; title: string }>> = {
  rbi_mpc: { key: 'IN', scope: 'market', title: 'RBI monetary policy decision' },
  india_cpi: { key: 'IN', scope: 'market', title: 'India CPI inflation release' },
  fomc: { key: 'US', scope: 'market', title: 'FOMC rate decision' },
  us_cpi: { key: 'US', scope: 'market', title: 'US CPI release' },
  us_nfp: { key: 'US', scope: 'market', title: 'US non-farm payrolls' },
  opec: { key: 'CRUDEOIL', scope: 'commodity', title: 'OPEC+ meeting' },
};

const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateMarketEventsFile(raw: unknown): MarketEventsFile {
  const f = (raw ?? {}) as Partial<MarketEventsFile>;
  const problems: string[] = [];
  if (f.version !== 1) problems.push(`version must be 1 (got ${JSON.stringify(f.version)})`);
  if (!Array.isArray(f.macro)) problems.push('macro must be an array');
  if (!Array.isArray(f.usFederalHolidays)) problems.push('usFederalHolidays must be an array');
  if (!Array.isArray(f.eiaOverrides)) problems.push('eiaOverrides must be an array');
  (f.macro ?? []).forEach((m, i) => {
    const at = `macro[${i}]`;
    if (!MACRO_KINDS.includes(m.kind)) problems.push(`${at}: kind "${m.kind}"`);
    if (!YMD.test(m.date ?? '')) problems.push(`${at}: date "${m.date}"`);
    if (!HHMM.test(m.localTime ?? '')) problems.push(`${at}: localTime "${m.localTime}"`);
    if (!isValidTimeZone(m.tz ?? '')) problems.push(`${at}: tz "${m.tz}"`);
    if (!['high', 'medium', 'low'].includes(m.impact)) problems.push(`${at}: impact "${m.impact}"`);
    if (!/^https:\/\//.test(m.sourceUrl ?? '')) problems.push(`${at}: sourceUrl must be https`);
  });
  (f.usFederalHolidays ?? []).forEach((d, i) => { if (!YMD.test(d)) problems.push(`usFederalHolidays[${i}]: "${d}"`); });
  (f.eiaOverrides ?? []).forEach((o, i) => {
    if (!['eia_petroleum', 'eia_natgas'].includes(o.kind) || !YMD.test(o.originalDate) || (o.date !== null && !YMD.test(o.date)) || (o.localTime !== undefined && !HHMM.test(o.localTime))) {
      problems.push(`eiaOverrides[${i}]: ${JSON.stringify(o)}`);
    }
  });
  if (problems.length > 0) throw new Error(`config/market-events.json is invalid: ${problems.join('; ')}`);
  return f as MarketEventsFile;
}

export function macroEvents(file: MarketEventsFile): MarketEventInput[] {
  return file.macro.map((m) => ({
    scope: MACRO_META[m.kind].scope, kind: m.kind, key: MACRO_META[m.kind].key, title: m.title ?? MACRO_META[m.kind].title,
    startsAt: zonedToUtc(m.date, m.localTime, m.tz), allDay: false, impact: m.impact,
    source: 'config/market-events.json', sourceRef: m.sourceUrl,
  }));
}

export function scheduleEndsAt(file: MarketEventsFile): string | null {
  return file.macro.reduce<string | null>((max, m) => (max === null || m.date > max ? m.date : max), null);
}

/** MARKET_EVENTS_CONFIG_PATH, else `config/market-events.json` found walking up from this file (as ai-gateway does). */
export function resolveMarketEventsPath(): string {
  const env = process.env.MARKET_EVENTS_CONFIG_PATH?.trim();
  if (env) return env;
  let dir = __dirname;
  for (;;) {
    const p = join(dir, 'config', 'market-events.json');
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`config/market-events.json not found above ${__dirname} (set MARKET_EVENTS_CONFIG_PATH)`);
    dir = parent;
  }
}

export function loadMarketEventsFile(path: string = resolveMarketEventsPath()): MarketEventsFile {
  return validateMarketEventsFile(JSON.parse(readFileSync(path, 'utf8')));
}
