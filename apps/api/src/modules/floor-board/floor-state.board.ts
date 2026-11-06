// apps/api/src/modules/floor-board/floor-state.board.ts
/**
 * The sentinel cycle's per-pass noise floor, in memory, for FLOOR_BROKER_SL (sentinel-executor
 * floor-broker-sl.service). The floor is solved every cycle pass (~30 s) but persisted only in verdict
 * packets, which are written when the judge is asked — often only at the exit itself (prod 2026-11-06
 * TITAN / FORCEMOT: one verdict, the EXIT_NOW). The resting stop has to trail the floor of EVERY pass.
 *
 * trade-sentinel and sentinel-executor may not import each other (sentinel-executor.structure.spec);
 * both import this neutral board. One process, so a plain module singleton. Memory only: a restart is
 * empty until the next pass, and an entry older than the reader's staleness bound is not trusted.
 * Never throws on publish: the cycle must not be affected by its reader.
 */
export interface FloorState {
  trackerId: string;
  userId: string;
  symbol: string;
  exchange: string;
  /** 'SENTINEL' | 'OBSERVE_ONLY' (the roster's ownership). */
  ownership: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  ltp: number;
  /** The noise floor as the cycle solved it this pass; null when discipline is off or N unknown (fixed floor). */
  floor: { basis: 'noise'; armed: boolean; level: number } | null;
  /** ms epoch of the pass. */
  at: number;
}

export class FloorStateBoard {
  private readonly states = new Map<string, FloorState>();

  publish(s: FloorState): void {
    try {
      if (!s || !s.trackerId) return;
      this.states.set(s.trackerId, { ...s, floor: s.floor ? { ...s.floor } : null });
    } catch {
      /* never affects the cycle */
    }
  }

  get(trackerId: string): FloorState | null {
    const s = this.states.get(trackerId);
    return s ? { ...s, floor: s.floor ? { ...s.floor } : null } : null;
  }

  /** Entries published at or after `sinceMs`, oldest first. */
  fresh(sinceMs: number): FloorState[] {
    return [...this.states.values()].filter((s) => s.at >= sinceMs).sort((a, b) => a.at - b.at).map((s) => ({ ...s }));
  }

  forget(trackerId: string): void {
    this.states.delete(trackerId);
  }

  clear(): void {
    this.states.clear();
  }
}

/** The process-wide board. */
export const FLOOR_STATE_BOARD = new FloorStateBoard();
