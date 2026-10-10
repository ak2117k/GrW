/**
 * Append-only rows with a future effectiveFrom (limits and the kill switch, spec
 * §5.2 and §5.4). The row in force is the most recently CREATED row whose
 * effectiveFrom ≤ now; the pending change is the newest row while it is not yet
 * effective. So a later row that is already effective (a tightening, or the same
 * value again) supersedes an earlier pending loosening for good. Repositories make
 * createdAt strictly increasing per user; id breaks a tie deterministically.
 */
export interface AppendOnlyRow {
  id: string;
  effectiveFrom: Date;
  createdAt: Date;
}

export interface Resolved<T> {
  inForce: T | null;
  pending: T | null;
  newest: T | null;
}

const newestFirst = (a: AppendOnlyRow, b: AppendOnlyRow): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function resolveAppendOnly<T extends AppendOnlyRow>(rows: readonly T[], now: Date): Resolved<T> {
  const sorted = [...rows].sort(newestFirst);
  const newest = sorted[0] ?? null;
  const inForce = sorted.find((r) => r.effectiveFrom.getTime() <= now.getTime()) ?? null;
  const pending = newest && newest.effectiveFrom.getTime() > now.getTime() ? newest : null;
  return { inForce, pending, newest };
}
