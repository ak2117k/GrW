import type { Direction } from './types';

/**
 * Contract §S rule 3 — clusters. One cluster per (underlying, direction) and window: a signal joins
 * the newest cluster of the same underlying + direction whose window opened at most
 * SIGNAL_CLUSTER_MIN ago, else it opens a new one. agreeCount = distinct channels in the cluster;
 * conflict = any opposite-direction signal on the same underlying within the window (both sides of a
 * conflict are flagged). A channel posting the same idea again never counts twice.
 */

export interface ClusterRow {
  id: string;
  underlying: string;
  direction: Direction;
  windowStart: Date;
  channelIds: string[];
  signalIds: string[];
  agreeCount: number;
  conflict: boolean;
}

export interface RecentSignal {
  id: string;
  channelId: string;
  direction: Direction;
  receivedAt: Date;
  clusterId: string | null;
}

export interface ClusterPlan {
  /** 'join' updates `cluster` in place (by id); 'create' inserts it (id empty). */
  action: 'join' | 'create';
  cluster: Omit<ClusterRow, 'id'> & { id: string | null };
  /** True when this signal's channel is NEW to an existing cluster: the cluster must be re-emitted. */
  corroborated: boolean;
  /** Opposite-direction clusters in the window that must now be flagged conflict. */
  conflictClusterIds: string[];
}

export function planCluster(
  sig: { id: string; channelId: string; underlying: string; direction: Direction; receivedAt: Date },
  sameSide: readonly ClusterRow[],
  recent: readonly RecentSignal[],
  windowMs: number,
): ClusterPlan {
  const at = sig.receivedAt.getTime();
  const inWindow = (d: Date) => at - d.getTime() <= windowMs && d.getTime() <= at + 60_000;
  const opposite = recent.filter((r) => r.direction !== sig.direction && inWindow(r.receivedAt));
  const conflict = opposite.length > 0;
  const conflictClusterIds = [...new Set(opposite.map((r) => r.clusterId).filter((x): x is string => !!x))];

  const open = [...sameSide]
    .filter((c) => c.underlying === sig.underlying && c.direction === sig.direction && inWindow(c.windowStart))
    .sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime())[0];

  if (open) {
    const newChannel = !open.channelIds.includes(sig.channelId);
    const channelIds = newChannel ? [...open.channelIds, sig.channelId] : open.channelIds;
    return {
      action: 'join',
      cluster: {
        ...open,
        channelIds,
        signalIds: open.signalIds.includes(sig.id) ? open.signalIds : [...open.signalIds, sig.id],
        agreeCount: channelIds.length,
        conflict: open.conflict || conflict,
      },
      corroborated: newChannel,
      conflictClusterIds,
    };
  }
  return {
    action: 'create',
    cluster: {
      id: null,
      underlying: sig.underlying,
      direction: sig.direction,
      windowStart: sig.receivedAt,
      channelIds: [sig.channelId],
      signalIds: [sig.id],
      agreeCount: 1,
      conflict,
    },
    corroborated: false,
    conflictClusterIds,
  };
}

/** Contract §S rule 4 — the identity of an idea within one channel (reposts / edits share it). */
export function dedupKey(s: {
  channelId: string;
  underlying: string;
  instrumentKind: string;
  strike: number | null;
  side: string;
  entryLow: number;
  entryHigh: number;
}): string {
  return [s.channelId, s.underlying, s.instrumentKind, s.strike ?? '-', s.side, s.entryLow, s.entryHigh].join('|');
}
