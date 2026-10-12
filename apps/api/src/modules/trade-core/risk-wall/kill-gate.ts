import { Logger } from '@nestjs/common';

/**
 * The entry gate the old silos call before opening a new position (owner answer 2,
 * decision 21). It never blocks exits, stops or square-offs: only new-entry points
 * call it. Fails closed: an unreadable state, or no reader wired, refuses the entry.
 */
export type GuardedEntry =
  | 'watch-monitor'
  | 'adaptive-stop-track'
  | 'ungated-track'
  | 'sell-futures-track'
  | 'breakout-swing-track'
  | 'anand-dual-track'
  | 'auto-execution'
  | 'auto-trade'
  | 'universe-scanner'
  | 'trade-engine';

export interface KillSwitchReadPort {
  /** This user's core kill switch is in force on. */
  isOn(userId: string): Promise<boolean>;
  /** Any ADMIN's core kill switch is in force on (the platform-wide silos have no userId). */
  isOnForPlatform(): Promise<boolean>;
  invalidate(): void;
}

export class CoreKillSwitchEntryBlockedError extends Error {
  constructor(
    public readonly entry: GuardedEntry,
    public readonly ref: string | null,
  ) {
    super(`${entry}: new entry${ref ? ` ${ref}` : ''} refused (core kill switch)`);
    this.name = 'CoreKillSwitchEntryBlockedError';
  }
}

const logger = new Logger('CoreKillGate');
let reader: KillSwitchReadPort | null = null;

export function setCoreKillSwitchReader(next: KillSwitchReadPort | null): void {
  reader = next;
}

export function invalidateCoreKillSwitchCache(): void {
  reader?.invalidate();
}

/**
 * `recheck: true` marks the second call an entry makes just before the write that opens
 * the position (the first call ran before seconds of quote / candle / login I/O, and the
 * switch may have been engaged, and the cascade run, in between). It changes only the
 * log line; the answer and the refusal are the same.
 */
export interface CoreEntryContext {
  userId?: string | null;
  ref?: string | null;
  recheck?: boolean;
}

export async function coreEntryAllowed(
  entry: GuardedEntry,
  ctx: CoreEntryContext = {},
): Promise<boolean> {
  let why: string;
  try {
    if (!reader) throw new Error('the kill switch reader is not wired');
    const on = ctx.userId ? await reader.isOn(ctx.userId) : await reader.isOnForPlatform();
    if (!on) return true;
    why = 'the core kill switch is on';
  } catch (err) {
    why = `the core kill switch state cannot be read (${err instanceof Error ? err.message : String(err)}); failing closed`;
  }
  const when = ctx.recheck ? ' at the re-check just before opening (engaged while the entry was being prepared)' : '';
  logger.warn(`[${entry}] new entry${ctx.ref ? ` ${ctx.ref}` : ''} refused${when}: ${why}`);
  return false;
}

export async function assertCoreEntryAllowed(
  entry: GuardedEntry,
  ctx: CoreEntryContext = {},
): Promise<void> {
  if (!(await coreEntryAllowed(entry, ctx))) throw new CoreKillSwitchEntryBlockedError(entry, ctx.ref ?? null);
}
