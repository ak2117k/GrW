import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import { strikesAround } from '../../mbm/domain/chain-snapshot';
import { listedExpiries, type SignalContract } from '../../signal-intake/domain/contract';
import { inferExpiry, type InferredExpiry } from '../../signal-intake/domain/expiry';
import { expiryOwnerIn } from '../../signal-intake/domain/expiry-owner';
import { instrumentHits } from '../../signal-intake/domain/prefilter';
import { isNumber, normalise } from '../../signal-intake/domain/text';
import type { ExpiryHint } from '../../signal-intake/domain/types';
import type { Vocabulary } from '../../signal-intake/domain/vocabulary';

/**
 * The option contracts a channel post names ("NIFTY 25700 PE above 330", "SENSEX 84000 CE 260 to 300"),
 * resolved against the instrument master, for the reader packet's `option` block. Pure.
 */

export interface OptionLeg {
  underlying: string;
  strike: number;
  kind: 'CE' | 'PE';
  /** The expiry the post wrote (one per post), else null = the nearest listed one. */
  expiryHint: ExpiryHint | null;
}

/** Option legs read per post (each costs a quote batch). */
export const MAX_OPTION_LEGS = 3;
/** Listed strikes each side of the slice centre. */
export const CHAIN_SLICE_STRIKES = 3;

/** Without the vocabulary: the same contract shapes, upper-cased, fused tokens split ("25700PE"). */
function looseTokens(text: string): string[] {
  const s = ` ${String(text ?? '').normalize('NFKC')} `
    .toUpperCase()
    .replace(/\b(\d{1,2}),(\d{3})(?=\s*(CE|PE)\b)/g, '$1$2')
    .replace(/\b([A-Z&]{2,}?)(\d{2,6}(?:\.\d+)?)(CE|PE)\b/g, '$1 $2 $3')
    .replace(/(\d)(CE|PE)\b/g, '$1 $2')
    .replace(/[^A-Z0-9&.]+/g, ' ')
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ');
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Every "<strike> CE|PE" pair in the post, each given to the nearest instrument named before it (the
 * signal-intake vocabulary's own instrument match on its normalised tokens; without a vocabulary, the
 * nearest preceding token that is one of `underlyings`). A pair with no preceding instrument belongs to
 * the post's only named underlying, else it is dropped. "25700 CE & PE" is both legs. The post's written
 * expiry (normalise lifts one per post) applies only to the legs on the underlying it was written next to
 * (see {@link expiryOwner}); every other leg takes the nearest listed expiry. Legs on an underlying outside
 * `only` (when given) are skipped BEFORE the cap. Unique, in post order, at most MAX_OPTION_LEGS.
 */
export function optionLegsOf(text: string, vocab: Vocabulary | null, underlyings: readonly string[], only?: ReadonlySet<string>): OptionLeg[] {
  const named = [...new Set(underlyings.map((u) => u.trim().toUpperCase()).filter(Boolean))];
  let tokens: string[];
  let expiryHint: ExpiryHint | null = null;
  let hits: Array<{ i: number; name: string }>;
  if (vocab) {
    const norm = normalise(text, vocab);
    tokens = norm.tokens;
    expiryHint = norm.expiry;
    hits = instrumentHits(tokens, vocab);
  } else {
    tokens = looseTokens(text);
    const set = new Set(named);
    hits = tokens.flatMap((t, i) => (set.has(t) ? [{ i, name: t }] : []));
  }
  const pairs: Array<{ at: number; strike: number; kind: 'CE' | 'PE' }> = [];
  for (let i = 1; i < tokens.length; i++) {
    if ((tokens[i] !== 'CE' && tokens[i] !== 'PE') || !isNumber(tokens[i - 1])) continue;
    const strike = Number(tokens[i - 1]);
    if (!(strike > 0)) continue;
    pairs.push({ at: i - 1, strike, kind: tokens[i] as 'CE' | 'PE' });
    // "25700 CE & PE" / "25700 CE AND PE" / "25700 CE / PE": the same strike's other side too.
    const other = tokens[i] === 'CE' ? 'PE' : 'CE';
    if (['&', 'AND', '/', '+'].includes(tokens[i + 1] ?? '') && tokens[i + 2] === other) pairs.push({ at: i - 1, strike, kind: other });
  }
  const owner = vocab && expiryHint ? expiryOwnerIn(text, vocab, hits, named) : null;
  const out: OptionLeg[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (out.length >= MAX_OPTION_LEGS) break;
    let underlying: string | null = null;
    for (const h of hits) if (h.i < p.at) underlying = h.name;
    if (!underlying && named.length === 1) underlying = named[0];
    if (!underlying || (only && !only.has(underlying))) continue;
    const key = `${underlying}|${p.strike}|${p.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ underlying, strike: p.strike, kind: p.kind, expiryHint: owner === underlying ? expiryHint : null });
  }
  return out;
}

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface ChainSide {
  token: string;
  tradingsymbol: string;
}

export interface ResolvedOptionLeg {
  ok: true;
  contract: SignalContract & { expiry: string; expirySource: InferredExpiry['source'] };
  /** Every listed strike of that underlying + expiry → its CE / PE contracts. */
  strikes: Map<number, { ce: ChainSide | null; pe: ChainSide | null }>;
}

/**
 * The leg's contract on `seg`: the post's expiry when it wrote one, else the nearest listed (signal-intake's
 * expiry inference over the master's listed expiries), plus that expiry's whole listed strike ladder.
 */
export function resolveOptionLeg(master: readonly unknown[], leg: OptionLeg, seg: string, now: Date): ResolvedOptionLeg | { ok: false; reason: string } {
  const listed = listedExpiries(master, leg.underlying, leg.kind, seg);
  if (listed.length === 0) return { ok: false, reason: `no ${leg.underlying} ${leg.kind} options in the instrument master on ${seg}` };
  const inferred = inferExpiry(leg.underlying, leg.kind, leg.expiryHint, now, listed, { exchange: seg });
  const expiry = inferred.expiry;
  if (!expiry) return { ok: false, reason: `no usable ${leg.underlying} option expiry` };
  // A named expiry the master does not list live (signal-intake's expiry inference says so when it can).
  const mismatch = (inferred as { mismatch?: string }).mismatch;
  if (mismatch) return { ok: false, reason: `${leg.underlying} ${leg.strike} ${leg.kind}: ${mismatch}` };
  const strikes = new Map<number, { ce: ChainSide | null; pe: ChainSide | null }>();
  for (const r of master as Row[]) {
    if (!r || up(r.exch_seg) !== seg || up(r.name) !== leg.underlying || !/^OPT/.test(up(r.instrumenttype))) continue;
    const e = parseMasterExpiry(r.expiry);
    if (!e || ymdLocal(e) !== expiry) continue;
    const k = parseMasterStrike(r.strike);
    const sym = up(r.symbol);
    const side = sym.endsWith('CE') ? 'ce' : sym.endsWith('PE') ? 'pe' : null;
    if (k === null || !side) continue;
    const slot = strikes.get(k) ?? { ce: null, pe: null };
    slot[side] = { token: String(r.token ?? ''), tradingsymbol: String(r.symbol ?? '') };
    strikes.set(k, slot);
  }
  const hit = [...strikes.entries()].find(([k]) => Math.abs(k - leg.strike) < 1e-6)?.[1]?.[leg.kind === 'CE' ? 'ce' : 'pe'];
  if (!hit) {
    const ks = [...strikes.keys()].sort((a, b) => a - b);
    const range = ks.length ? ` (listed strikes ${ks[0]} to ${ks[ks.length - 1]})` : '';
    return { ok: false, reason: `${leg.underlying} ${leg.strike} ${leg.kind} is not listed for expiry ${expiry}${range}` };
  }
  return { ok: true, contract: { exchange: seg, token: hit.token, tradingsymbol: hit.tradingsymbol, expiry, expirySource: inferred.source }, strikes };
}

/** The listed strike nearest `centre` plus CHAIN_SLICE_STRIKES each side, ascending. */
export function chainSliceStrikes(strikes: readonly number[], centre: number): number[] {
  return strikesAround(strikes, centre, CHAIN_SLICE_STRIKES);
}
