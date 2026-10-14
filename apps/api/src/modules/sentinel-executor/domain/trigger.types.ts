// apps/api/src/modules/sentinel-executor/domain/trigger.types.ts
/** Price triggers (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md). */
export type TriggerInstrument = 'UNDERLYING' | 'PREMIUM';
export type TriggerOp = 'BELOW' | 'ABOVE';

export interface WatchRef {
  exchange: string;
  token: string;
  symbol: string;
}

/** Fixed timings (plan rulings R6, R9, R10, R15). Not configuration: changing them changes safety. */
export const TRIGGER_TIMING = {
  /** A tick whose receipt time is further than this from now is ignored. */
  tickMaxAgeMs: 5_000,
  /** A gap longer than this between two accepted ticks restarts confirmation. */
  tickGapResetMs: 5_000,
  /** Arming needs the watched instrument priced at most this long ago. */
  armPriceMaxAgeMs: 15_000,
  /** How long an unpriced proposal waits for its (new) watch to price. */
  armDeferMs: 30_000,
  /** Proposals older than this when first seen are ignored (the next verdict re-proposes). */
  armLookbackMs: 180_000,
  passMs: 5_000,
  maintenanceMs: 30_000,
  /** An armed key unpriced this long during its session logs STARVED once. */
  starvedMs: 60_000,
  perPass: 10,
} as const;

/** Hub watch owner for UNDERLYING instruments the executor subscribes (priority 1). */
export const TRIGGER_WATCH_OWNER = 'sentinel-triggers';
