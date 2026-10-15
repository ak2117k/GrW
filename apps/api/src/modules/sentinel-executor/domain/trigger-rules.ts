// apps/api/src/modules/sentinel-executor/domain/trigger-rules.ts
import type { TriggerConfig } from './trigger-config';
import { TRIGGER_TIMING, type TriggerInstrument, type TriggerOp } from './trigger.types';

export type ContractKind = 'CE' | 'PE' | 'FUT';

export interface TriggerLevel {
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
}

const SUFFIX = /\d(CE|PE|FUT)$/;

/** CE / PE / FUT from the tradingsymbol suffix (same rule as market-hub/underlying.ts). */
export function contractKindOf(symbol: string): ContractKind | null {
  const m = SUFFIX.exec(String(symbol ?? '').trim().toUpperCase());
  return m ? (m[1] as ContractKind) : null;
}

/**
 * Ruling R4 (D5): the cross direction that HURTS this position on this
 * instrument. PREMIUM is the contract's own price: a long loses when it falls.
 * UNDERLYING depends on the delta's sign: long CE/FUT and short PE gain when the
 * underlying rises (so BELOW hurts); long PE and short CE/FUT the reverse.
 */
export function adverseOp(instrument: TriggerInstrument, qty: number, kind: ContractKind | null): TriggerOp | null {
  if (!Number.isFinite(qty) || qty === 0) return null;
  const long = qty > 0;
  if (instrument === 'PREMIUM') return long ? 'BELOW' : 'ABOVE';
  if (kind === null) return null;
  const gainsWhenUnderlyingRises = kind === 'PE' ? !long : long;
  return gainsWhenUnderlyingRises ? 'BELOW' : 'ABOVE';
}

const no = (reason: string) => ({ ok: false as const, reason });

/**
 * Spec §3.2, in order. Pure; every input that needs I/O is resolved by the caller.
 * The first failing rule names the REJECTED reason.
 */
export function validateTrigger(i: {
  proposal: TriggerLevel;
  qty: number;
  kind: ContractKind | null;
  current: { price: number; ageMs: number } | null;
  armed: TriggerLevel | null;
  cfg: Pick<TriggerConfig, 'maxDistancePct' | 'tightenOnly'>;
}): { ok: true } | { ok: false; reason: string } {
  const p = i.proposal;
  if (!Number.isFinite(p.price) || p.price <= 0) return no('BAD_PRICE');
  const adverse = adverseOp(p.instrument, i.qty, i.kind);
  if (adverse === null) return no(p.instrument === 'UNDERLYING' ? 'UNKNOWN_CONTRACT_KIND' : 'NO_POSITION');
  if (p.op !== adverse) return no('NOT_PROTECTIVE');
  const c = i.current;
  if (!c || !Number.isFinite(c.price) || c.price <= 0 || c.ageMs > TRIGGER_TIMING.armPriceMaxAgeMs) return no('NO_FRESH_PRICE');
  const notYetCrossed = p.op === 'BELOW' ? p.price < c.price : p.price > c.price;
  if (!notYetCrossed) return no('ALREADY_CROSSED');
  const pct = (Math.abs(c.price - p.price) / c.price) * 100;
  const max = i.cfg.maxDistancePct[p.instrument];
  if (pct > max) return no(`TOO_FAR (${pct.toFixed(2)}% > ${max}%)`);
  if (i.armed && i.cfg.tightenOnly) {
    if (i.armed.instrument !== p.instrument) return no('INSTRUMENT_SWITCH');
    const loosens = p.op === 'BELOW' ? p.price < i.armed.price : p.price > i.armed.price;
    if (loosens) return no('LOOSENS');
  }
  return { ok: true };
}
