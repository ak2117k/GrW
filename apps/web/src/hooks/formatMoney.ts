// Indian digit grouping (lakh/crore), up to 2 decimals, no forced padding.
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/**
 * Render a broker rupee amount as `₹…` with Indian (lakh/crore) grouping.
 *
 * IMPORTANT: Angel One RMS funds/positions are already denominated in RUPEES
 * (not paise), so there is NO `/100` conversion here — `formatMoney(125000)`
 * is ₹1,25,000, never ₹1,250. Null-safe: null/undefined/NaN render as `₹0`.
 */
export function formatMoney(amount: number | null | undefined): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${inr.format(Math.abs(n))}`;
}
