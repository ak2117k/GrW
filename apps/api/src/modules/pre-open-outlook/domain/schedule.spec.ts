import { globalPricesEnabled, offHoursNewsDue, offHoursNewsEnabled, outlookEnabled, PRE_OPEN_CRONS } from './schedule';

describe('pre-open schedules and switches', () => {
  it('crons: outlook 08:30 Mon–Fri, global prices every 30 min every day, news off-hours nights + weekends', () => {
    expect(PRE_OPEN_CRONS.outlook).toBe('0 30 8 * * 1-5');
    expect(PRE_OPEN_CRONS.globalPrices).toBe('0 0,30 * * * *');
    expect(PRE_OPEN_CRONS.newsOffHoursWeekday).toBe('0 0,30 0-7 * * 1-5');
    expect(PRE_OPEN_CRONS.newsOffHoursWeekend).toBe('0 0,30 * * * 0,6');
  });

  it('BOOT_JOBS=false stops everything; each switch stops only its job; default on', () => {
    expect(outlookEnabled({})).toBe(true);
    expect(globalPricesEnabled({})).toBe(true);
    expect(offHoursNewsEnabled({})).toBe(true);
    for (const f of [outlookEnabled, globalPricesEnabled, offHoursNewsEnabled]) expect(f({ BOOT_JOBS: 'false' })).toBe(false);
    expect(outlookEnabled({ PRE_OPEN_OUTLOOK: 'off' })).toBe(false);
    expect(globalPricesEnabled({ PRE_OPEN_OUTLOOK: 'off' })).toBe(true);
    expect(globalPricesEnabled({ GLOBAL_PRICES: 'OFF' })).toBe(false);
    expect(offHoursNewsEnabled({ NEWS_OFFHOURS_FETCH: 'false' })).toBe(false);
  });

  it('the off-hours news fetch never doubles the regular weekday 08:00–23:30 IST fetch', () => {
    const ist = (s: string) => new Date(`${s}+05:30`);
    expect(offHoursNewsDue(ist('2026-11-02T10:00:00'))).toBe(false); // Mon 10:00
    expect(offHoursNewsDue(ist('2026-11-02T23:30:00'))).toBe(false);
    expect(offHoursNewsDue(ist('2026-11-02T07:30:00'))).toBe(true); // Mon 07:30
    expect(offHoursNewsDue(ist('2026-11-03T00:00:00'))).toBe(true); // Tue 00:00
    expect(offHoursNewsDue(ist('2026-10-31T14:00:00'))).toBe(true); // Sat
    expect(offHoursNewsDue(ist('2026-11-01T22:30:00'))).toBe(true); // Sun
  });
});
