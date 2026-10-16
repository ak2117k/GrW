import type { MarketEventInput } from '../types';
import { addDaysYmd, weekdayOfYmd, zonedToUtc } from './zoned-time';

export interface EiaOverride { kind: 'eia_petroleum' | 'eia_natgas'; originalDate: string; date: string | null; localTime?: string }

const ET = 'America/New_York';
const SPEC = {
  eia_petroleum: { key: 'CRUDEOIL', title: 'EIA weekly petroleum status report', source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)' },
  eia_natgas: { key: 'NATURALGAS', title: 'EIA weekly natural gas storage report', source: 'rule: EIA natural gas storage (Thu 10:30 ET)' },
} as const;

/**
 * Spec §8 + plan "differs" 12. Petroleum: Wednesday 10:30 ET, Thursday when a US federal
 * holiday falls Mon–Wed of that week. Natural gas: Thursday 10:30 ET. `overrides` (from
 * config/market-events.json) move or cancel a single release by its rule date.
 */
export function eiaEvents(fromYmd: string, days: number, usHolidays: readonly string[], overrides: readonly EiaOverride[]): MarketEventInput[] {
  const hol = new Set(usHolidays);
  const out: MarketEventInput[] = [];
  const push = (kind: keyof typeof SPEC, ruleDate: string, date: string, time: string) => {
    const o = overrides.find((x) => x.kind === kind && x.originalDate === ruleDate);
    if (o && o.date === null) return;
    const s = SPEC[kind];
    out.push({
      scope: 'commodity', kind, key: s.key, title: s.title,
      startsAt: zonedToUtc(o?.date ?? date, o?.localTime ?? time, ET), allDay: false, impact: 'high',
      source: s.source, sourceRef: `${kind}:${ruleDate}`,
    });
  };
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(fromYmd, i);
    const wd = weekdayOfYmd(ymd);
    if (wd === 3) {
      const shifted = [addDaysYmd(ymd, -2), addDaysYmd(ymd, -1), ymd].some((d) => hol.has(d));
      push('eia_petroleum', ymd, shifted ? addDaysYmd(ymd, 1) : ymd, '10:30');
    }
    if (wd === 4) push('eia_natgas', ymd, ymd, '10:30');
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
