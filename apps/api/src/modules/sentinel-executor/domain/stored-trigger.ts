// apps/api/src/modules/sentinel-executor/domain/stored-trigger.ts
import type { TriggerInstrument, TriggerOp, WatchRef } from './trigger.types';

/**
 * READER of sentinel_verdicts.exitTrigger. WIRE CONTRACT with
 * trade-sentinel/services/exit-trigger-proposal.ts (ruling R17): declared on both
 * sides because the modules may not import each other; both specs pin the same
 * fixture. Never throws — a bad row becomes a REJECTED trigger with a reason.
 */
export type StoredTrigger =
  | { kind: 'trigger'; trigger: { instrument: TriggerInstrument; op: TriggerOp; price: number; watch: WatchRef | null } }
  | { kind: 'problem'; problem: string };

const problem = (p: string): StoredTrigger => ({ kind: 'problem', problem: p });

export function parseStoredTrigger(json: unknown): StoredTrigger {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return problem('stored exitTrigger is not an object');
  const o = json as Record<string, unknown>;
  if (o.v !== 1) return problem(`stored exitTrigger version ${JSON.stringify(o.v)} is not 1`);
  if (typeof o.problem === 'string') return problem(o.problem);
  if (o.instrument !== 'UNDERLYING' && o.instrument !== 'PREMIUM') return problem(`instrument ${JSON.stringify(o.instrument)}`);
  if (o.op !== 'BELOW' && o.op !== 'ABOVE') return problem(`op ${JSON.stringify(o.op)}`);
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0) return problem(`price ${JSON.stringify(o.price)}`);
  let watch: WatchRef | null = null;
  if (o.watch !== null && o.watch !== undefined) {
    const w = o.watch as Record<string, unknown>;
    if (typeof w !== 'object' || typeof w.exchange !== 'string' || typeof w.token !== 'string' || typeof w.symbol !== 'string') {
      return problem('watch is malformed');
    }
    watch = { exchange: w.exchange, token: w.token, symbol: w.symbol };
  }
  return { kind: 'trigger', trigger: { instrument: o.instrument, op: o.op, price: o.price, watch } };
}
