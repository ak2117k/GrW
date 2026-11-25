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
/** A string with something in it (whitespace-only is not text). */
const text = (v: unknown): v is string => str(v) && v.trim().length > 0;

/** Normalise an evidence value / packet scalar for matching: trim, drop commas, ₹ and %. */
const norm = (v: string) => v.trim().replace(/[,₹%]/g, '').trim();
/** The number in a normalised value (a leading + is fine), rounded to 2 dp; null when it is not a plain number. */
function num2(v: string): number | null {
  const s = norm(v).replace(/^\+/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}

/** What evidence can be checked against: every number (2 dp) and the lower-cased serialized packet. */
export interface PacketIndex {
  numbers: Set<number>;
  serialized: string;
  /** Status of the block a dotted source path names ('present' / 'unavailable' / …), or null when it names none. */
  statusOf(source: string): string | null;
}

/** Index a packet once for evidence checks. */
export function indexPacket(packet: unknown): PacketIndex {
  const numbers = new Set<number>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === 'number' && Number.isFinite(v)) numbers.add(Math.round(v * 100) / 100);
    else if (typeof v === 'string') {
      const n = num2(v);
      if (n !== null) numbers.add(n);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (isObj(v)) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(packet, 0);
  const serialized = norm(JSON.stringify(packet ?? null)).toLowerCase();
  const resolve = (path: string[]): string | null => {
    let node: unknown = packet;
    let status: string | null = null;
    for (const key of path) {
      if (!isObj(node)) return status;
      if (node.status === 'unavailable') return 'unavailable';
      if (key in node) node = node[key];
      else if (node.status === 'present' && isObj(node.value) && key in node.value) node = node.value[key];
      else if (isObj(node.context) && node.context.status === 'unavailable') return 'unavailable'; // a whole instrument failed
      else return null;
      if (isObj(node) && str(node.status)) status = node.status;
    }
    return status;
  };
  return {
    numbers,
    serialized,
    statusOf(source: string) {
      const path = source.trim().split('.').map((k) => k.trim()).filter(Boolean);
      if (path.length === 0) return null;
      // The model sometimes names a pulse block bare ("breadth" for marketPulse.breadth).
      return resolve(path) ?? (path[0] !== 'marketPulse' ? resolve(['marketPulse', ...path]) : null);
    },
  };
}

/** True when the evidence value appears in the packet: as a number (2 dp) or, for words, in its text. */
function valueInPacket(value: string, idx: PacketIndex): boolean {
  const n = num2(value);
  if (n !== null) return idx.numbers.has(n);
  const s = norm(value).toLowerCase();
  return s.length > 0 && idx.serialized.includes(s);
}

function readEvidence(raw: unknown): Result<Evidence[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: 'evidence is not an array' };
  const out: Evidence[] = [];
  for (const e of raw) {
    if (!isObj(e) || !text(e.fact) || !text(e.value) || !str(e.source)) return { ok: false, reason: 'bad evidence item' };
    out.push({ fact: e.fact, value: e.value, source: e.source });
  }
  return { ok: true, value: out };
}

function readClaim(raw: unknown, i: number, idx: PacketIndex | null): Result<Claim> {
  if (!isObj(raw)) return { ok: false, reason: `claim ${i} is not an object` };
  if (!text(raw.text) || !text(raw.subject)) return { ok: false, reason: `claim ${i} missing text/subject` };
  if (!oneOf(CLAIM_BIASES, raw.bias)) return { ok: false, reason: `claim ${i} bad bias` };
  if (!oneOf(CLAIM_HORIZONS, raw.horizon)) return { ok: false, reason: `claim ${i} bad horizon` };
  if (!oneOf(CLAIM_TYPES, raw.claimType)) return { ok: false, reason: `claim ${i} bad claimType` };
  if (!oneOf(CLAIM_VERDICTS, raw.verdict)) return { ok: false, reason: `claim ${i} bad verdict` };
  const ev = readEvidence(raw.evidence);
  if (!ev.ok) return { ok: false, reason: `claim ${i} ${ev.reason}` };
  const claim: Claim = {
    text: raw.text,
    subject: raw.subject.trim().toUpperCase(),
    bias: raw.bias,
    horizon: raw.horizon,
    claimType: raw.claimType,
    verdict: raw.verdict,
    evidence: ev.value,
  };
  // A verdict with no numbers behind it is not a verdict: keep the claim, mark it UNCLEAR and flag it.
  // Against the packet it was read with: evidence from an unavailable block, or numbers found nowhere in it,
  // is not evidence either.
  if ((claim.verdict === 'CONFIRMED' || claim.verdict === 'CONTRADICTED') && (claim.evidence.length === 0 || (idx && !evidenceHolds(claim.evidence, idx)))) {
    claim.verdict = 'UNCLEAR';
    claim.evidenceMissing = true;
  }
  return { ok: true, value: claim };
}

/** (a) no evidence item cites an unavailable packet block, and (b) at least one evidence value is in the packet. */
function evidenceHolds(evidence: Evidence[], idx: PacketIndex): boolean {
  if (evidence.some((e) => idx.statusOf(e.source) === 'unavailable')) return false;
  return evidence.some((e) => valueInPacket(e.value, idx));
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
 * untrusted). Rejects anything off-contract (incl. whitespace-only text / subject / summary / evidence fact or
 * value); downgrades an evidence-free CONFIRMED / CONTRADICTED to UNCLEAR with evidenceMissing. With the
 * `packet` the post was read against, also downgrades one whose evidence cites an unavailable block, or none of
 * whose evidence values (trimmed, commas / ₹ / % stripped, numbers to 2 dp) appear anywhere in the packet.
 */
export function validateReading(raw: unknown, packet?: unknown): { ok: true; reply: ReaderReply } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'reply is not an object' };
  if (!oneOf(READ_KINDS, raw.kind)) return { ok: false, reason: `bad kind ${String(raw.kind)}` };
  if (!oneOf(READ_SCOPES, raw.scope)) return { ok: false, reason: `bad scope ${String(raw.scope)}` };
  if (!Array.isArray(raw.claims)) return { ok: false, reason: 'claims is not an array' };
  if (!text(raw.summary)) return { ok: false, reason: 'summary is not a non-blank string' };
  const idx = packet === undefined ? null : indexPacket(packet);
  const claims: Claim[] = [];
  for (const [i, c] of raw.claims.entries()) {
    const r = readClaim(c, i, idx);
    if (!r.ok) return r;
    claims.push(r.value);
  }
  const call = readCall(raw.call);
  if (!call.ok) return call;
  return { ok: true, reply: { kind: raw.kind, scope: raw.scope, claims, call: call.value, summary: raw.summary } };
}
