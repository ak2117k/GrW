/**
 * Part B: live prices for the tick-driven sensors, as a PORT — so the cycle's
 * reachability walk (shadow mode is structural) never reaches market-hub. Bound
 * to HubTickStream in trade-sentinel.module.ts, the composition root.
 */
export const TICK_STREAM = 'SENTINEL_TICK_STREAM';

export interface StreamTick {
  /** EXCHANGE:token */
  key: string;
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
}

export interface TickStream {
  /** Subscribe to every price the hub learns for this user. null = no hub serves the user. */
  subscribe(userId: string, fn: (t: StreamTick) => void): (() => void) | null;
}
