/**
 * Dates for chains, in the instrument master's convention: master-contract.ts stores `expiry` at
 * HOST-LOCAL midnight (MarketDataRepository.getNearestFuture relies on the same). Reading with the
 * same host-local helpers makes writer and reader agree on any host timezone (the VPS is UTC).
 */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function nextYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/** When an option on `exchange` expires on `ymd`: 15:30 IST (MCX: 23:30 IST), as an absolute instant. */
export function expiryCloseAt(ymd: string, exchange: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const utcHour = exchange.toUpperCase() === 'MCX' ? 18 : 10; // 23:30 / 15:30 IST
  return new Date(Date.UTC(y, m - 1, d, utcHour, 0));
}
