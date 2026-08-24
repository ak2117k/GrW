/** Feed subscription pressure over a process lifetime. */
export interface SlotPressure {
  primaryHighWater: number;
  primaryMax: number;
  rejections: number;
  saturated: boolean;
}

/**
 * Tracks how close the primary subscription pool has come to its cap.
 *
 * `getStatus().primarySubscriptions` is a POINT reading — it said 29 of 30 once,
 * which proves nothing about whether the cap is ever actually reached. A price
 * that never updates because its token could not get a slot is invisible in a
 * point reading and obvious in a high-water mark next to a rejection count.
 *
 * Deliberately in-memory and per-process: the question is "does this container
 * saturate during a session", and it is answered by reading the value before
 * the container restarts. Persisting it would be a second table for a number
 * that costs nothing to re-derive.
 */
export class SlotPressureTracker {
  private highWater = 0;
  private rejections = 0;

  constructor(private readonly primaryMax: number) {}

  observe(primaryCount: number): void {
    if (primaryCount > this.highWater) this.highWater = primaryCount;
  }

  reject(): void {
    this.rejections++;
  }

  snapshot(): SlotPressure {
    return {
      primaryHighWater: this.highWater,
      primaryMax: this.primaryMax,
      rejections: this.rejections,
      saturated: this.highWater >= this.primaryMax,
    };
  }
}
