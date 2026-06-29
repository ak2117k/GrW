/**
 * Pure formatting helpers for the Strategy Review page. Kept separate from the
 * component so they can be unit-tested.
 */

/** Format a percentage value to 1 decimal place, e.g. 62.5 -> "62.5%". */
export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

/**
 * Format a signed rupee amount: en-IN grouping, leading sign, ₹ symbol.
 * e.g. 123456.7 -> "+₹1,23,457", -2500 -> "-₹2,500".
 */
export function fmtRupees(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return `${sign}₹${abs}`;
}

/** Format an expectancy / ratio number to 2 decimals (unsigned grouping). */
export function fmtNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format an integer count with en-IN grouping, e.g. 123456 -> "1,23,456". */
export function fmtCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-IN');
}

/**
 * Tailwind text-colour class for a signed value: green positive, red negative,
 * muted/secondary zero.
 */
export function signColor(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-red-400';
  return 'text-[var(--color-text-secondary)]';
}
