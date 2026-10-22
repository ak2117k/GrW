/** One bar of past open interest from Angel's historical/v1/getOIData. */
export interface OiPoint {
  ts: Date;
  oi: number;
}

const toNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * Angel getOIData `data` → points. The documented row is `{ time: '2026-10-22T09:15:00+05:30', oi: 123 }`;
 * `[time, oi]` arrays and `timestamp`/`date` / `openInterest` field names are accepted too, so a quiet
 * shape change degrades to "unparsed" rows the caller can count instead of NaNs in the table.
 * Rows without a valid time or a finite, non-negative OI are dropped. Non-array input → [].
 */
export function mapOiRows(rows: unknown): OiPoint[] {
  if (!Array.isArray(rows)) return [];
  const out: OiPoint[] = [];
  for (const r of rows) {
    let t: unknown;
    let oi: unknown;
    if (Array.isArray(r)) {
      t = r[0];
      oi = r[r.length - 1];
    } else if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      t = o.time ?? o.timestamp ?? o.date;
      oi = o.oi ?? o.openInterest ?? o.open_interest;
    } else continue;
    const ts = typeof t === 'string' || typeof t === 'number' ? new Date(t) : null;
    const n = toNumber(oi);
    if (!ts || Number.isNaN(ts.getTime()) || !Number.isFinite(n) || n < 0) continue;
    out.push({ ts, oi: n });
  }
  return out;
}
