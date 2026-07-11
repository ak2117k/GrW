/**
 * Progress toward a monitor's target, as a percentage in [0, 100].
 *
 * `currentPercent` is how far the LTP has moved from the reference price
 * (see `StockMonitor.currentPercent`); `targetPercent` is the configured
 * target profit. The result is the fraction of the target reached, clamped
 * to 0–100 so a not-yet-priced (null) or overshooting monitor still renders
 * a sane progress bar.
 *
 * Null-safe: a null/undefined/NaN `currentPercent` reads as 0 progress; a
 * null/undefined/zero/negative `targetPercent` has no meaningful denominator
 * and yields 0.
 */
export function progressPct(
  currentPercent: number | null | undefined,
  targetPercent: number | null | undefined,
): number {
  const target =
    typeof targetPercent === 'number' && Number.isFinite(targetPercent)
      ? targetPercent
      : 0;
  if (target <= 0) return 0;

  const current =
    typeof currentPercent === 'number' && Number.isFinite(currentPercent)
      ? currentPercent
      : 0;

  const ratio = (current / target) * 100;
  if (ratio <= 0) return 0;
  if (ratio >= 100) return 100;
  return ratio;
}
