/**
 * Number formatters for quote fields that arrive over the network.
 *
 * A quote payload is produced by a backend that can change shape independently
 * of this bundle (per-user broker tick vs level-book seed vs WS feed). Calling
 * `.toFixed()` directly on one of those fields throws during render if it is
 * absent, and a throw in render unmounts the entire tree — the user sees a
 * blank page because one number was missing. These helpers degrade to an em
 * dash instead.
 *
 * Defence in depth only: the endpoint IS contracted to send these fields
 * (see `tick-to-quote.ts` on the API side). A dash means the producer is
 * broken and worth chasing — it is not an expected state.
 */

/** Format a number, or "—" when it is missing / not finite. */
export function fmtNumOrDash(value: number | undefined | null, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * Format a price, coercing 0 → "—". The level-book-seeded quote (used
 * after-hours when no live tick is cached) reports 0 for fields the book
 * doesn't track yet (Day H/L/Open before today's first tick); rendering
 * "0.00" would read as a real price rather than an unknown one.
 */
export function fmtPriceOrDash(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value.toFixed(2)
    : '—';
}
