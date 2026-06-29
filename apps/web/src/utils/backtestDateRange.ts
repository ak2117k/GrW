/** Date-range helpers for the backtest config form. */

export type DateRangePreset = '1M' | '3M' | '6M' | '1Y' | 'YTD';

/** Quick-range preset buttons, in display order. */
export const DATE_PRESETS: readonly DateRangePreset[] = [
  '1M',
  '3M',
  '6M',
  '1Y',
  'YTD',
];

/** A Date as YYYY-MM-DD (IST calendar date) — the format `<input type="date">` uses. */
export function toIsoDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Today as YYYY-MM-DD (IST). */
export function todayIso(): string {
  return toIsoDate(new Date());
}

/**
 * A `{ startDate, endDate }` range ending today and spanning back by the
 * preset. `YTD` runs from January 1st of the current year.
 */
export function presetRange(preset: DateRangePreset): {
  startDate: string;
  endDate: string;
} {
  const end = new Date();
  const start = new Date();
  switch (preset) {
    case '1M':
      start.setMonth(start.getMonth() - 1);
      break;
    case '3M':
      start.setMonth(start.getMonth() - 3);
      break;
    case '6M':
      start.setMonth(start.getMonth() - 6);
      break;
    case '1Y':
      start.setFullYear(start.getFullYear() - 1);
      break;
    case 'YTD':
      start.setMonth(0, 1); // January 1st of the current year
      break;
  }
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
}
