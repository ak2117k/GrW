import type { CoreSquareOffCause } from '../risk-wall/ports';

/**
 * Ruling L14: what the risk seams need from the lifecycle, as tokens. Both are bound to
 * CoreLifecycleService with useExisting (Task 13). CORE_SQUARE_OFF resolves
 * CORE_POSITION_EXITS lazily through ModuleRef, because the adapter the lifecycle uses
 * injects the kill switch, which injects CORE_SQUARE_OFF.
 */
export const LIFECYCLE_MARKS = Symbol('LIFECYCLE_MARKS');
export const CORE_POSITION_EXITS = Symbol('CORE_POSITION_EXITS');

export interface LifecycleMarks {
  /** The newest price the lifecycle holds for the position (receipt time `at`, ms), or null. */
  mark(positionId: string): { ltp: number; at: number } | null;
}

export interface CorePositionExits {
  exitAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<{ exitsRequested: number }>;
}
