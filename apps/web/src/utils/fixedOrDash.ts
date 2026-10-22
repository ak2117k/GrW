/**
 * `value.toFixed(decimals)` that tolerates a missing reading.
 *
 * The API sends `null` for "no reading" (e.g. `setupContext.volumeRatio` on an
 * index, where Angel reports no volume and there is no option-chain proxy).
 * Calling `.toFixed` on that crashed the whole Signals page, so every
 * nullable number rendered with fixed decimals goes through here: a missing
 * or non-finite value renders as an em dash instead of throwing.
 */
export function fixedOrDash(value: number | null | undefined, decimals = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}
