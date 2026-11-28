import type { Claim, ReasonCode } from './reading.types';

/** A packet block's failure reason → its reason code (the reasons reader-packet.service writes). */
export function reasonCodeOf(reason: string): ReasonCode {
  const r = reason.toLowerCase();
  // Capacity refusals: the per-minute budget and the in-flight quote / build limits.
  if (/reader quote budget|reader quote limit|reader build limit/.test(r)) return 'QUOTE_BUDGET';
  if (r.includes('stale quote')) return 'STALE';
  if (r.includes('timed out')) return 'TIMEOUT';
  if (r.includes('no instrument')) return 'NO_INSTRUMENT';
  if (/\bbars?\b/.test(r)) return 'NO_BARS';
  return 'OTHER';
}

type Block = { status?: unknown; reason?: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const failed = (b: unknown): string | null => {
  const x = b as Block | null;
  return isObj(x) && x.status === 'unavailable' && typeof x.reason === 'string' ? x.reason : null;
};

/**
 * The failure behind a claim's subject in the packet: its instrument's quote, then its context, then any
 * other failed block; MARKET → the indices / breadth blocks; a sector → the sectors block. An instrument
 * the packet does not carry at all → 'no instrument'.
 */
function failedReasonFor(subject: string, packet: unknown, isInstrument: (s: string) => boolean): string | null {
  const p = isObj(packet) ? packet : {};
  const instruments = isObj(p.instruments) ? p.instruments : {};
  const pulse = isObj(p.marketPulse) ? p.marketPulse : {};
  const inst = instruments[subject];
  if (isObj(inst)) return failed(inst.quote) ?? failed(inst.context) ?? Object.values(inst).map(failed).find((r) => r !== null) ?? null;
  if (subject === 'MARKET') return failed(pulse.indices) ?? failed(pulse.breadth);
  if (isInstrument(subject)) return `no instrument block for ${subject} in the packet`;
  return failed(pulse.sectors);
}

/**
 * Every NOT_CHECKABLE claim gets a reasonCode: the failed packet block's reason when it maps to a code,
 * else the model's own code, else OTHER. The model's FORWARD_LOOKING is kept as is: a claim about the future is
 * not checkable whatever block failed (e.g. a refused option block on the same subject). Other verdicts carry none.
 */
export function fillReasonCodes(claims: readonly Claim[], packet: unknown, isInstrument: (s: string) => boolean = () => false): Claim[] {
  // Validation guarantees an array of claims; anything else passes through untouched (never throws).
  if (!Array.isArray(claims)) return claims as Claim[];
  return claims.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const { reasonCode: own, ...rest } = c;
    if (c.verdict !== 'NOT_CHECKABLE') return rest;
    if (own === 'FORWARD_LOOKING') return { ...rest, reasonCode: own };
    const reason = failedReasonFor(c.subject, packet, isInstrument);
    const fromBlock = reason === null ? null : reasonCodeOf(reason);
    const code: ReasonCode = fromBlock && fromBlock !== 'OTHER' ? fromBlock : (own ?? fromBlock ?? 'OTHER');
    return { ...rest, reasonCode: code };
  });
}
