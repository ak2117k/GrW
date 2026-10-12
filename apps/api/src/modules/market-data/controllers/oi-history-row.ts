type NumericLike = number | bigint | { toString(): string };

export interface OiSnapshotRowLike {
  oi: NumericLike;
  /** NULL = no baseline yet (first snapshot of the day / scanner-only underlying). */
  oiChange: NumericLike | null;
  volume: NumericLike;
  timestamp: Date;
}

/** One `oi_snapshots` row on the wire: numbers as numbers, an unknown OI change as null (never 0). */
export function oiHistoryRow(snap: OiSnapshotRowLike): { oi: number; oiChange: number | null; volume: number; timestamp: Date } {
  return {
    oi: Number(snap.oi),
    oiChange: snap.oiChange === null || snap.oiChange === undefined ? null : Number(snap.oiChange),
    volume: Number(snap.volume),
    timestamp: snap.timestamp,
  };
}
