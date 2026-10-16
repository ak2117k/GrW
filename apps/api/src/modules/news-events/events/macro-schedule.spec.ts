import { loadMarketEventsFile, macroEvents, resolveMarketEventsPath, scheduleEndsAt, validateMarketEventsFile } from './macro-schedule';
import { eiaEvents } from './rule-events';

const good = {
  version: 1,
  usFederalHolidays: ['2026-11-26'],
  eiaOverrides: [],
  macro: [
    { kind: 'fomc', date: '2026-12-09', localTime: '14:00', tz: 'America/New_York', impact: 'high', sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
    { kind: 'rbi_mpc', date: '2026-12-04', localTime: '10:00', tz: 'Asia/Kolkata', impact: 'high', sourceUrl: 'https://www.rbi.org.in/' },
  ],
};

it('a valid file becomes events with the right keys and UTC instants', () => {
  const f = validateMarketEventsFile(good);
  expect(macroEvents(f)).toEqual([
    expect.objectContaining({ kind: 'fomc', key: 'US', scope: 'market', title: 'FOMC rate decision', startsAt: new Date('2026-12-09T19:00:00.000Z'), impact: 'high', source: 'config/market-events.json' }),
    expect.objectContaining({ kind: 'rbi_mpc', key: 'IN', startsAt: new Date('2026-12-04T04:30:00.000Z') }),
  ]);
  expect(scheduleEndsAt(f)).toBe('2026-12-09');
});

it('every problem is reported at once', () => {
  const bad = { ...good, macro: [{ kind: 'gdp', date: '2026-13-01', localTime: '25:00', tz: 'Mars/Olympus', impact: 'huge', sourceUrl: 'ftp://x' }] };
  expect(() => validateMarketEventsFile(bad)).toThrow(/kind "gdp".*date "2026-13-01".*localTime "25:00".*tz "Mars\/Olympus".*impact "huge".*sourceUrl/s);
  expect(() => validateMarketEventsFile({ version: 2 })).toThrow(/version/);
});

it('the checked-in config/market-events.json is valid and covers every macro kind', () => {
  const f = loadMarketEventsFile(resolveMarketEventsPath());
  const kinds = new Set(f.macro.map((m) => m.kind));
  for (const k of ['rbi_mpc', 'fomc', 'us_cpi', 'india_cpi', 'us_nfp', 'opec']) expect(kinds.has(k as never)).toBe(true);
  expect(f.usFederalHolidays.length).toBeGreaterThanOrEqual(20);
});

it('the checked-in EIA overrides reproduce the published Veterans Day / Thanksgiving 2026 shifts', () => {
  const f = loadMarketEventsFile(resolveMarketEventsPath());
  const got = eiaEvents('2026-11-09', 21, f.usFederalHolidays, f.eiaOverrides).map((e) => `${e.kind}@${e.startsAt.toISOString()}`);
  expect(got).toEqual([
    'eia_petroleum@2026-11-12T17:00:00.000Z', // Wed Veterans Day → Thu 12:00 ET
    'eia_natgas@2026-11-13T15:30:00.000Z', // → Fri 10:30 ET
    'eia_petroleum@2026-11-18T15:30:00.000Z',
    'eia_natgas@2026-11-19T15:30:00.000Z',
    'eia_petroleum@2026-11-25T15:30:00.000Z', // Thanksgiving is Thu: petroleum stays Wed
    'eia_natgas@2026-11-25T17:00:00.000Z', // → Wed 12:00 ET
  ]);
});
