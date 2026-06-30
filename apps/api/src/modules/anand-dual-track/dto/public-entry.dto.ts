// The only sanctioned serializer for emitting an anand (Intraday/Swing) entry
// to a non-ADMIN user. Allowlist-by-construction: it builds a fresh object from
// named fields and never spreads the source, so a new column on
// IntradayEntry/SwingEntry can never leak. See TDA-006 spec §3.

export const ANAND_PROVENANCE_KEYS = [
  'scannerName', 'scoreBreakdown', 'leadCount', 'leadDates', 'trailing', 'exitReason',
] as const;

export interface PublicAnandEntry {
  id: string;
  symbol: string;
  segment: 'INTRADAY' | 'SWING';
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number | null;
  pnlPct: number | null;
  targetLeftPct: number | null;
  priceStale: boolean;
}

// Loose input — accepts the raw/enriched row shape the controller already builds.
export interface AnandEntryLike {
  id: string; symbol: string; entryPrice: number; enteredAt: string | Date;
  targetPct: number; stopPct: number; status: string;
  exitPrice?: number | null; exitedAt?: string | Date | null;
  currentPrice?: number | null; pnlPct?: number | null; targetLeftPct?: number | null;
  priceStale?: boolean;
  [extra: string]: unknown; // provenance fields may be present — deliberately ignored
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

export function toPublicEntry(row: AnandEntryLike, segment: 'INTRADAY' | 'SWING'): PublicAnandEntry {
  return {
    id: row.id,
    symbol: row.symbol,
    segment,
    entryPrice: row.entryPrice,
    enteredAt: iso(row.enteredAt) as string,
    targetPct: row.targetPct,
    stopPct: row.stopPct,
    status: row.status,
    exitPrice: row.exitPrice ?? null,
    exitedAt: iso(row.exitedAt),
    currentPrice: row.currentPrice ?? null,
    pnlPct: row.pnlPct ?? null,
    targetLeftPct: row.targetLeftPct ?? null,
    priceStale: row.priceStale ?? false,
  };
}
