import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { AI_HEALTH, type AiHealthPort } from '../ai-gateway/audit/failover-transport';
import {
  EXIT_EXECUTION_READER,
  SUPREME_CONFIRM,
  TRACKER_WAKE,
  type ExitExecutionReaderPort,
  type ConfirmRequest,
  type ConfirmResult,
  type SupremeConfirmPort,
  type TrackerWakePort,
} from './exit-authority.tokens';
import { HARD_LOSS_PROBE, OWNER_EXIT, type HardLossProbe, type OwnerExitOptions, type OwnerExitPort } from './services/escalation-runner.service';

/**
 * LATE-BOUND PORTS (Task 7 wiring). Five ports the exit authority CONSUMES are IMPLEMENTED in modules that themselves
 * import ExitAuthorityModule:
 *
 *   TRACKER_WAKE     ← TradeSentinelModule   `{ provide: TRACKER_WAKE, useExisting: SentinelRunnerService }`
 *   HARD_LOSS_PROBE  ← TradeSentinelModule   (SentinelCycleService.hardLossStillPast)
 *   AI_HEALTH        ← TradeSentinelModule   (the sentinel's failover transport)
 *   OWNER_EXIT       ← SentinelExecutorModule (ManualExitService.request as the owner)
 *   SUPREME_CONFIRM  ← DeskManagerModule     `{ provide: SUPREME_CONFIRM, useExisting: SupremeConfirmService }`
 *   EXIT_EXECUTION_READER ← SentinelExecutorModule (its execution repository; read-only)
 *
 * Importing those modules here would be a module cycle, and the providers form a real instance cycle too
 * (TradeAlarmsService → SentinelRunnerService → SentinelCycleService → TradeAlarmsService). So this module provides
 * each of those tokens as a thin forwarder that finds the REAL binding on first use through
 * `ModuleRef.get(token, { strict: false, each: true })` — every instance registered under the token anywhere in the
 * app — skipping the forwarders themselves. Each implementing module binds the SAME token, so the wiring reads
 * exactly as the plan states it.
 *
 * Unbound in a process ⇒ the forwarder THROWS (`PortUnboundError`) and logs ERROR once; every consumer already
 * treats a throwing port as a failure (a failed wake / exit / probe / confirm is logged, told to the owner and
 * retried), never as silence. `ExitAuthorityWiringCheck` (services/wiring-check.service.ts) resolves them all at
 * boot and logs ERROR for any that are unbound when TRADE_AGENT_AUTHORITY=live is requested.
 */
export const LATE_PORT = Symbol('exit-authority.late-port');

export class PortUnboundError extends Error {
  constructor(readonly port: string) {
    super(`[exit-authority] ${port} is not bound in this process`);
    this.name = 'PortUnboundError';
  }
}

const log = new Logger('ExitAuthorityPorts');

/** Finds the real instance behind one late-bound token (cached once found). */
export class LateBinding<T> {
  private target: T | null = null;
  private warned = false;

  constructor(
    private readonly ref: Pick<ModuleRef, 'get'>,
    readonly token: symbol,
    readonly name: string,
  ) {}

  /** The real instance, or null when nothing but forwarders is registered under the token. */
  resolve(): T | null {
    if (this.target) return this.target;
    let found: unknown[] = [];
    try {
      const got = this.ref.get(this.token, { strict: false, each: true }) as unknown;
      found = Array.isArray(got) ? got : [got];
    } catch {
      found = [];
    }
    const real = found.find((x) => x != null && !(x as Record<symbol, unknown>)[LATE_PORT]);
    if (real) this.target = real as T;
    return this.target;
  }

  /** The real instance; throws PortUnboundError (ERROR logged once) when unbound. */
  require(): T {
    const t = this.resolve();
    if (t) return t;
    if (!this.warned) {
      this.warned = true;
      log.error(`[exit-authority] ${this.name} is not bound in this process: calls to it fail (see late-ports.ts)`);
    }
    throw new PortUnboundError(this.name);
  }
}

type Late<T> = T & { readonly [LATE_PORT]: LateBinding<T> };

function mark<T extends object>(port: T, binding: LateBinding<T>): Late<T> {
  Object.defineProperty(port, LATE_PORT, { value: binding, enumerable: false });
  return port as Late<T>;
}

/** The binding behind a forwarder (null for a real instance). */
export function lateBindingOf(port: unknown): LateBinding<unknown> | null {
  return ((port as Record<symbol, unknown> | null)?.[LATE_PORT] as LateBinding<unknown> | undefined) ?? null;
}

export function lateTrackerWake(ref: Pick<ModuleRef, 'get'>): Late<TrackerWakePort> {
  const b = new LateBinding<TrackerWakePort>(ref, TRACKER_WAKE, 'TRACKER_WAKE');
  return mark({ wakeTracker: (userId: string, trackerId: string, why: string) => b.require().wakeTracker(userId, trackerId, why) }, b);
}

export function lateSupremeConfirm(ref: Pick<ModuleRef, 'get'>): Late<SupremeConfirmPort> {
  const b = new LateBinding<SupremeConfirmPort>(ref, SUPREME_CONFIRM, 'SUPREME_CONFIRM');
  return mark({ confirm: (req: ConfirmRequest): Promise<ConfirmResult> => b.require().confirm(req) }, b);
}

export function lateHardLossProbe(ref: Pick<ModuleRef, 'get'>): Late<HardLossProbe> {
  const b = new LateBinding<HardLossProbe>(ref, HARD_LOSS_PROBE, 'HARD_LOSS_PROBE');
  return mark({
    stillPastLimit: (trackerId: string) => b.require().stillPastLimit(trackerId),
    // Optional facet: unbound or not implemented ⇒ unknown (null).
    productIntraday: (trackerId: string) => b.resolve()?.productIntraday?.(trackerId) ?? null,
  }, b);
}

export function lateOwnerExit(ref: Pick<ModuleRef, 'get'>): Late<OwnerExitPort> {
  const b = new LateBinding<OwnerExitPort>(ref, OWNER_EXIT, 'OWNER_EXIT');
  return mark({
    exitAsOwner: (userId: string, trackerId: string, reason: string, opts?: OwnerExitOptions) => b.require().exitAsOwner(userId, trackerId, reason, opts),
  }, b);
}

export function lateAiHealth(ref: Pick<ModuleRef, 'get'>): Late<AiHealthPort> {
  const b = new LateBinding<AiHealthPort>(ref, AI_HEALTH, 'AI_HEALTH');
  return mark({ allDownSince: () => b.require().allDownSince() }, b);
}

/**
 * EXIT_EXECUTION_READER ← SentinelExecutorModule (its execution repository, read-only). Unbound ⇒ throws, and the
 * runner treats the row as unreadable (retries; never sells blind on an unseen execution).
 */
export function lateExitExecutionReader(ref: Pick<ModuleRef, 'get'>): Late<ExitExecutionReaderPort> {
  const b = new LateBinding<ExitExecutionReaderPort>(ref, EXIT_EXECUTION_READER, 'EXIT_EXECUTION_READER');
  return mark({ executionForVerdict: (verdictId: string) => b.require().executionForVerdict(verdictId) }, b);
}

/** The late-bound tokens, for the boot wiring check and the module specs. */
export const LATE_PORT_TOKENS = [TRACKER_WAKE, SUPREME_CONFIRM, HARD_LOSS_PROBE, OWNER_EXIT, AI_HEALTH, EXIT_EXECUTION_READER] as const;
