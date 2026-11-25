import {
  CLAIM_BIASES,
  CLAIM_HORIZONS,
  CLAIM_TYPES,
  CLAIM_VERDICTS,
  READ_KINDS,
  READ_SCOPES,
  type Claim,
  type Evidence,
  type ReaderCall,
  type ReaderReply,
} from './reading.types';

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function readEvidence(raw: unknown): Result<Evidence[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: 'evidence is not an array' };
  const out: Evidence[] = [];
  for (const e of raw) {
    if (!isObj(e) || !str(e.fact) || !str(e.value) || !str(e.source)) return { ok: false, reason: 'bad evidence item' };
    out.push({ fact: e.fact, value: e.value, source: e.source });
  }
  return { ok: true, value: out };
}

function readClaim(raw: unknown, i: number): Result<Claim> {
  if (!isObj(raw)) return { ok: false, reason: `claim ${i} is not an object` };
  if (!str(raw.text) || !str(raw.subject)) return { ok: false, reason: `claim ${i} missing text/subject` };
  if (!oneOf(CLAIM_BIASES, raw.bias)) return { ok: false, reason: `claim ${i} bad bias` };
  if (!oneOf(CLAIM_HORIZONS, raw.horizon)) return { ok: false, reason: `claim ${i} bad horizon` };
  if (!oneOf(CLAIM_TYPES, raw.claimType)) return { ok: false, reason: `claim ${i} bad claimType` };
  if (!oneOf(CLAIM_VERDICTS, raw.verdict)) return { ok: false, reason: `claim ${i} bad verdict` };
  const ev = readEvidence(raw.evidence);
  if (!ev.ok) return { ok: false, reason: `claim ${i} ${ev.reason}` };
  const claim: Claim = {
    text: raw.text,
    subject: raw.subject,
    bias: raw.bias,
    horizon: raw.horizon,
    claimType: raw.claimType,
    verdict: raw.verdict,
    evidence: ev.value,
  };
  // A verdict with no numbers behind it is not a verdict: keep the claim, mark it UNCLEAR and flag it.
  if ((claim.verdict === 'CONFIRMED' || claim.verdict === 'CONTRADICTED') && claim.evidence.length === 0) {
    claim.verdict = 'UNCLEAR';
    claim.evidenceMissing = true;
  }
  return { ok: true, value: claim };
}

function readCall(raw: unknown): Result<ReaderCall | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!isObj(raw)) return { ok: false, reason: 'call is not an object' };
  if (!str(raw.underlying) || !raw.underlying.trim()) return { ok: false, reason: 'call missing underlying' };
  if (raw.side !== 'BUY' && raw.side !== 'SELL') return { ok: false, reason: 'call bad side' };
  if (raw.optionType !== null && raw.optionType !== 'CE' && raw.optionType !== 'PE') return { ok: false, reason: 'call bad optionType' };
  const levels: Record<'strike' | 'entryLow' | 'entryHigh' | 'stopLoss', number | null> = { strike: null, entryLow: null, entryHigh: null, stopLoss: null };
  for (const k of Object.keys(levels) as (keyof typeof levels)[]) {
    const v = raw[k];
    if (v !== null && !finite(v)) return { ok: false, reason: `call bad ${k}` };
    levels[k] = v;
  }
  if (!Array.isArray(raw.targets) || !raw.targets.every(finite)) return { ok: false, reason: 'call bad targets' };
  return {
    ok: true,
    value: { underlying: raw.underlying, side: raw.side, optionType: raw.optionType, ...levels, targets: [...raw.targets] },
  };
}

/**
 * Re-check the model's reply against the contract (the schema is enforced upstream, but the reply is still
 * untrusted). Rejects anything off-contract; downgrades an evidence-free CONFIRMED / CONTRADICTED to UNCLEAR.
 */
export function validateReading(raw: unknown): { ok: true; reply: ReaderReply } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'reply is not an object' };
  if (!oneOf(READ_KINDS, raw.kind)) return { ok: false, reason: `bad kind ${String(raw.kind)}` };
  if (!oneOf(READ_SCOPES, raw.scope)) return { ok: false, reason: `bad scope ${String(raw.scope)}` };
  if (!Array.isArray(raw.claims)) return { ok: false, reason: 'claims is not an array' };
  if (!str(raw.summary)) return { ok: false, reason: 'summary is not a string' };
  const claims: Claim[] = [];
  for (const [i, c] of raw.claims.entries()) {
    const r = readClaim(c, i);
    if (!r.ok) return r;
    claims.push(r.value);
  }
  const call = readCall(raw.call);
  if (!call.ok) return call;
  return { ok: true, reply: { kind: raw.kind, scope: raw.scope, claims, call: call.value, summary: raw.summary } };
}
