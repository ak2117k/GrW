import { refKey } from './hub.types';
import type { WatchEntry } from './watch-registry';

export interface Allocation {
  live: WatchEntry[];
  nearLive: WatchEntry[];
  /** P0/P1 entries that did not get a live slot: polled on the Critical lane. */
  criticalOverflow: WatchEntry[];
  demoted: number;
}

/** Live slots by priority, then first-watch time, then key — never first come first served. */
export function allocateSlots(entries: readonly WatchEntry[], cap: number): Allocation {
  const sorted = [...entries].sort(
    (a, b) =>
      a.priority - b.priority ||
      a.firstAt - b.firstAt ||
      refKey(a.ref).localeCompare(refKey(b.ref)),
  );
  const live = sorted.slice(0, Math.max(0, cap));
  const nearLive = sorted.slice(Math.max(0, cap));
  return {
    live,
    nearLive,
    criticalOverflow: nearLive.filter((e) => e.priority <= 1),
    demoted: nearLive.length,
  };
}
