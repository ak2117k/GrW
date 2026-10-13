// apps/api/src/modules/sentinel-executor/domain/auto-exit.types.ts
export type AutoExitMode = 'dry-run' | 'live';

export type AiExitStatus =
  | 'CLAIMED'
  | 'SKIPPED'
  | 'DRY_RUN'
  | 'PLACED'
  | 'FILLED'
  | 'REJECTED'
  | 'FAILED';

/** Which broker session served the attempt (plan ruling R1). */
export type SessionSource = 'user-feed' | 'ephemeral';

/** Statuses that count toward the per-user IST-day cap (spec §5.3). */
export const COUNTED_STATUSES: readonly AiExitStatus[] = ['PLACED', 'FILLED', 'DRY_RUN'];

/**
 * FAILED reasons after which an order MAY exist at the broker (review fix 2):
 * the placement answer was not definitive, or the process died mid-flight. Such
 * rows count toward the cap and block further exits on the same position for
 * the rest of the IST day.
 */
export const UNKNOWN_FATE_REASONS: readonly string[] = ['ORDER_UNCERTAIN', 'INTERRUPTED'];

/** Only derivative venues are in scope (spec §3). */
export const AUTO_EXIT_EXCHANGES: readonly string[] = ['NFO', 'BFO', 'MCX'];

/**
 * The unit Angel expects for an order `quantity` on an exchange (plan ruling R16).
 * Positions `netqty` is taken to be in UNITS; `lots` means the order quantity is
 * |netqty| / lotSize. Unverified for MCX, so MCX has NO default.
 */
export type QtyUnit = 'units' | 'lots';

/**
 * Defaults for AI_AUTO_EXIT_QTY_UNITS. NFO/BFO orders are already sent in units by
 * the existing order paths (auto-trade-risk-sizing: quantity = lots * lotSize).
 * MCX is deliberately absent: an unconfigured exchange can never go live.
 */
export const DEFAULT_QTY_UNITS: Readonly<Record<string, QtyUnit>> = { NFO: 'units', BFO: 'units' };

export interface AutoExitConfig {
  enabled: boolean;
  mode: AutoExitMode;
  userIds: string[];
  dailyCap: number;
  maxVerdictAgeSec: number;
  limitFallbackPct: number;
  /** Order quantity unit per exchange (R16). A missing exchange = unit unverified. */
  qtyUnits: Partial<Record<string, QtyUnit>>;
  /** Human-readable notes about values that were ignored in favour of a safe default. */
  problems: string[];
}
