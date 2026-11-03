/**
 * Schedules and switches of the pre-open outlook module (six-field crons, evaluated in IST). Pure.
 *
 *   outlook        08:30 IST Mon–Fri (per underlying, only on its venue's trading day).
 *   global prices  every 30 min, every day (weekends included: the Sunday-evening reopen of
 *                  US futures is exactly what a Monday outlook needs).
 *   news off-hours when the RSS news fetch does not run (news-fetch.schedule.ts runs weekdays
 *                  08:00–23:30 IST every 5 min): weekday nights every 30 min 00:00–04:30, then every
 *                  10 min 05:00–07:50 (US results / US close land ~05:30–09:30 IST; from 08:00 the
 *                  regular 5-min fetch takes over, so the overnight read is continuous to 09:00 and
 *                  beyond without a second cron on the same minutes), and all weekend every 30 min.
 *                  Prod 2 Nov: every weekend crude story was ingested at 08:00 IST Monday.
 *
 * Switches: BOOT_JOBS=false stops all three; PRE_OPEN_OUTLOOK=off, GLOBAL_PRICES=off and
 * NEWS_OFFHOURS_FETCH=off stop one each (default on).
 */
export const PRE_OPEN_CRONS = Object.freeze({
  outlook: '0 30 8 * * 1-5',
  globalPrices: '0 0,30 * * * *',
  newsOffHoursWeekday: '0 0,30 0-4 * * 1-5',
  newsOffHoursDawn: '0 */10 5-7 * * 1-5',
  newsOffHoursWeekend: '0 0,30 * * * 0,6',
});

type Env = Record<string, string | undefined>;
const isOff = (v: string | undefined) => ['off', 'false', '0', 'no'].includes(String(v ?? '').trim().toLowerCase());

export function bootJobsOn(env: Env): boolean {
  return env.BOOT_JOBS !== 'false';
}
export function outlookEnabled(env: Env): boolean {
  return bootJobsOn(env) && !isOff(env.PRE_OPEN_OUTLOOK);
}
export function globalPricesEnabled(env: Env): boolean {
  return bootJobsOn(env) && !isOff(env.GLOBAL_PRICES);
}
export function offHoursNewsEnabled(env: Env): boolean {
  return bootJobsOn(env) && !isOff(env.NEWS_OFFHOURS_FETCH);
}

const istParts = (at: Date) => {
  const d = new Date(at.getTime() + 5.5 * 3_600_000);
  return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

/**
 * Should the off-hours news fetch enqueue at `at`? Only when the regular RSS fetch is NOT scheduled
 * (weekdays 08:00–23:30 IST), so the two never double up.
 */
export function offHoursNewsDue(at: Date): boolean {
  const { dow, min } = istParts(at);
  const weekday = dow >= 1 && dow <= 5;
  const regular = weekday && min >= 8 * 60 && min <= 23 * 60 + 30;
  return !regular;
}

/** The IST date (YYYY-MM-DD) of `at`. */
export function istYmd(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
