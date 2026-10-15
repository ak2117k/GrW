/**
 * The judge's machine-readable exit level (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md §3.1).
 *
 * SHAPE ONLY. Whether a level is protective, close enough, tighter than the one
 * already armed, or priced at all is decided by sentinel-executor at arming time,
 * against the live hub price (plan ruling R1). This module never validates
 * semantics and never arms anything — it cannot: nothing here reaches an order.
 *
 * Checked in code because the CLI judge cannot enforce VERDICT_SCHEMA (the
 * schema only travels as prompt text there). A malformed trigger never costs the
 * verdict it rides on (ruling R12).
 */
export type TriggerInstrument = 'UNDERLYING' | 'PREMIUM';
export type TriggerOp = 'BELOW' | 'ABOVE';

export interface ExitTriggerProposal {
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
}

export type ProposalParse =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'proposal'; proposal: ExitTriggerProposal }
  | { kind: 'malformed'; problem: string };

const FIELDS = ['instrument', 'op', 'price'];
const malformed = (problem: string): ProposalParse => ({ kind: 'malformed', problem });

export function parseExitTriggerProposal(raw: Record<string, unknown>): ProposalParse {
  if (!Object.prototype.hasOwnProperty.call(raw, 'exitTrigger')) return { kind: 'absent' };
  const t = raw.exitTrigger;
  if (t === null) return { kind: 'none' };
  if (typeof t !== 'object' || Array.isArray(t)) return malformed('exitTrigger is not an object or null');
  const o = t as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0) return malformed(`unexpected field(s) ${extra.join(', ')}`);
  if (o.instrument !== 'UNDERLYING' && o.instrument !== 'PREMIUM') {
    return malformed(`instrument ${JSON.stringify(o.instrument)} is not UNDERLYING|PREMIUM`);
  }
  if (o.op !== 'BELOW' && o.op !== 'ABOVE') return malformed(`op ${JSON.stringify(o.op)} is not BELOW|ABOVE`);
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0) {
    return malformed(`price ${JSON.stringify(o.price)} is not a positive number`);
  }
  return { kind: 'proposal', proposal: { instrument: o.instrument, op: o.op, price: o.price } };
}

export interface WatchRef {
  exchange: string;
  token: string;
  symbol: string;
}

/**
 * WIRE CONTRACT with sentinel-executor/domain/stored-trigger.ts (ruling R17): the
 * two modules may not import each other, so this shape is declared on both sides
 * and pinned by the identical STORED_TRIGGER_FIXTURE in both specs.
 */
export interface StoredExitTriggerV1 {
  v: 1;
  instrument?: TriggerInstrument;
  op?: TriggerOp;
  price?: number;
  /** UNDERLYING: where underlyingLtp was read (index / NSE cash / MCX future). PREMIUM: null. */
  watch?: WatchRef | null;
  /** What the judge saw on that instrument when it set the level (audit only). */
  seen?: { price: number | null; at: string | null };
  /** Set instead of the fields above when the judge's trigger was malformed. */
  problem?: string;
}

export const STORED_TRIGGER_FIXTURE: StoredExitTriggerV1 = {
  v: 1,
  instrument: 'UNDERLYING',
  op: 'BELOW',
  price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  seen: { price: 8951, at: '2026-10-13T16:59:58.000Z' },
};

/** What the cycle persists on sentinel_verdicts.exitTrigger, or null for nothing. */
export function exitTriggerRecord(
  verdict: { verdict: string; exitTrigger?: ExitTriggerProposal | null; exitTriggerProblem?: string },
  tick: { ltp: number; underlyingLtp: number | null; underlyingLtpAt: string | null; underlyingRef?: WatchRef | null },
): StoredExitTriggerV1 | null {
  if (verdict.verdict !== 'HOLD' && verdict.verdict !== 'EXIT_ARMED') return null;
  if (verdict.exitTriggerProblem) return { v: 1, problem: verdict.exitTriggerProblem };
  const p = verdict.exitTrigger;
  if (!p) return null;
  if (p.instrument === 'UNDERLYING') {
    return {
      v: 1, instrument: p.instrument, op: p.op, price: p.price,
      watch: tick.underlyingRef ?? null,
      seen: { price: tick.underlyingLtp, at: tick.underlyingLtpAt },
    };
  }
  return { v: 1, instrument: p.instrument, op: p.op, price: p.price, watch: null, seen: { price: tick.ltp, at: null } };
}
