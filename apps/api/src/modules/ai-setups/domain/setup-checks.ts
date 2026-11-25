import { classCeilingFor } from '../../../common/utils/loss-limit';
import { indexPacket, type PacketIndex } from '../../message-reader/domain/reading-validate';
import { SETUP_ENTRY_TYPES, type SetupEvidence, type SetupPlan, type SetupReply } from './setup.types';

/**
 * The deterministic checks that can veto an AI setup (plan Global Constraints). Pure: everything it needs is
 * in the reply and the context the caller measured. Any failure ⇒ the caller stores NO_TRADE with `failed`.
 *
 * Entry reference prices (underlying):
 *  - expected fill (R:R): LIMIT_PULLBACK = zone mid; BREAKOUT_TRIGGER = trigger; MARKET_NOW = current LTP.
 *  - worst fill (loss ceiling): a CE pullback fills coming DOWN, so at the zone top (a PE's at the zone bottom);
 *    a breakout at the far side of its zone/trigger; MARKET_NOW at LTP. The ceiling check is a safety bound,
 *    so it uses the worst fill.
 */

/** Plan Global Constraints: no class ceiling (HARD_LOSS_CEILING_BY_CLASS off / class not listed) ⇒ ₹2,000. */
export const DEFAULT_SETUP_CEILING_RUPEES = 2000;
export const MIN_REWARD_RISK = 1.2;
export const ANTI_CHASE_ATR = 1.5;
export const MAX_SPREAD_PCT = 2;
/** Intraday only: latest validUntil (IST 'HH:mm') by exchange family. */
export const NSE_LAST_VALID = '15:15';
export const MCX_LAST_VALID = '23:00';

export type SetupCheckFailure =
  | 'malformed'
  | 'not_option_buy'
  | 'ltp_unavailable'
  | 'atr_unavailable'
  | 'delta_unavailable'
  | 'lot_unavailable'
  | 'spread_unavailable'
  | 'oi_unavailable'
  | 'no_evidence'
  | 'evidence_not_in_packet'
  | 'level_not_a_level'
  | 'sl_wrong_side'
  | 'targets_wrong_side'
  | 'pullback_wrong_side'
  | 'anti_chase'
  | 'rr_below_min'
  | 'spread_too_wide'
  | 'oi_too_low'
  | 'valid_until_after_close'
  | 'sl_too_wide';

export type SetupCheckResult = { ok: true } | { ok: false; failed: SetupCheckFailure; detail: string };

export interface SetupCheckContext {
  /** The setup packet the model saw (cited values / levels must be in it). */
  packet: unknown;
  /** Underlying LTP now. */
  ltpUnderlying: number | null;
  /** ATR14 of the underlying's 15m session bars. */
  atr15m: number | null;
  /** Delta of the named option (sign ignored). */
  delta: number | null;
  lotSize: number | null;
  /** Plan 1 class ceiling (setupCeilingFor); null ⇒ ₹2,000. */
  ceiling: number | null;
  /** Bid/ask spread of the named option, % of its price. */
  spreadPct: number | null;
  /** Open interest of the named option, contracts. */
  oi: number | null;
  minOi: number;
  /** Exchange of the option (NFO / BFO / MCX); decides the intraday cut-off. Default NSE. */
  exchange?: string | null;
}

/** The ₹ loss ceiling a setup's SL must fit: Plan 1 `classCeilingFor`, else ₹2,000. */
export function setupCeilingFor(symbol: string, exchange: string | null | undefined, env: Record<string, string | undefined> = process.env): number {
  return classCeilingFor(symbol, exchange, env) ?? DEFAULT_SETUP_CEILING_RUPEES;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 1e-9;

const fail = (failed: SetupCheckFailure, detail: string): SetupCheckResult => ({ ok: false, failed, detail });

/** Normalise a value as the reader does: trim, drop commas, ₹ and %. */
const norm = (v: string) => v.trim().replace(/[,₹%]/g, '').trim();
function num2(v: string): number | null {
  const s = norm(v).replace(/^\+/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return r2(Number(s));
}

/** A cited value is in the packet: as a number (2 dp) or, for words, in its text. */
function valueInPacket(value: string, idx: PacketIndex): boolean {
  const n = num2(value);
  if (n !== null) return idx.numbers.has(n);
  const s = norm(value).toLowerCase();
  return s.length > 0 && idx.serialized.includes(s);
}

/** Every evidence item holds: none cites an unavailable block, every value is in the packet. */
function badEvidence(evidence: SetupEvidence[], idx: PacketIndex): SetupEvidence | null {
  for (const e of evidence) {
    if (idx.statusOf(e.source) === 'unavailable' || !valueInPacket(e.value, idx)) return e;
  }
  return null;
}

/** Fields whose number is a price level an entry may anchor to (matched by key, any case, anywhere in a present block). */
export const LEVEL_KEYS: ReadonlySet<string> = new Set(['dayhigh', 'daylow', 'prevhigh', 'prevlow', 'prevclose', 'high60d', 'low60d', 'vwap']);

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isBar = (v: unknown): v is { high: number; low: number } => isRec(v) && finite(v.high) && finite(v.low);

/** 15m swing highs / lows: an interior bar whose high (low) is ≥ (≤) both neighbours'. */
function swingLevels(bars: Array<{ high: number; low: number }>, out: Set<number>): void {
  for (let i = 1; i < bars.length - 1; i++) {
    const [a, b, c] = [bars[i - 1], bars[i], bars[i + 1]];
    if (b.high >= a.high && b.high >= c.high) out.add(r2(b.high));
    if (b.low <= a.low && b.low <= c.low) out.add(r2(b.low));
  }
}

/**
 * The price levels an entry may cite, from the packet alone: every number under a LEVEL_KEYS field, plus the
 * swing highs / lows of any bar array under a `bars15m` key — skipping unavailable blocks — minus the current
 * LTP (an entry anchored to the price it enters at is no anchor). Rounded to 2 dp. Strike, OI, volume, open,
 * ATR and every other packet number are not levels.
 */
export function packetLevels(packet: unknown, ltp: number | null): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown, inBars: boolean, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(v)) {
      if (inBars && v.length > 0 && v.every(isBar)) swingLevels(v, out);
      else for (const x of v) walk(x, inBars, depth + 1);
      return;
    }
    if (!isRec(v) || v.status === 'unavailable') return;
    for (const [k, x] of Object.entries(v)) {
      if (LEVEL_KEYS.has(k.toLowerCase()) && finite(x)) out.add(r2(x));
      else walk(x, inBars || k === 'bars15m', depth + 1);
    }
  };
  walk(packet, false, 0);
  if (finite(ltp)) out.delete(r2(ltp));
  return out;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function shapeError(s: SetupPlan): string | null {
  const e = s.entry;
  if (!e || !SETUP_ENTRY_TYPES.includes(e.type)) return 'bad entry type';
  if (!finite(e.low) || !finite(e.high) || e.low <= 0 || e.low > e.high) return `bad entry zone ${e.low}–${e.high}`;
  if (e.trigger !== null && !finite(e.trigger)) return 'bad trigger';
  if (e.level !== null && !finite(e.level)) return 'bad level';
  if (e.type === 'BREAKOUT_TRIGGER' && e.trigger === null) return 'BREAKOUT_TRIGGER without a trigger';
  if (!finite(s.sl) || s.sl <= 0) return 'bad sl';
  if (!Array.isArray(s.targets) || !s.targets.every(finite)) return 'bad targets';
  if (typeof s.validUntil !== 'string' || !HHMM.test(s.validUntil.trim())) return `bad validUntil ${String(s.validUntil)}`;
  if (!Array.isArray(s.evidence)) return 'bad evidence';
  if (!s.instrument || typeof s.instrument.symbol !== 'string' || !s.instrument.symbol.trim()) return 'bad instrument';
  return null;
}

/**
 * Check one setup reply against the mandatory code rules, in order: contract (option BUY, well-formed), data
 * present (LTP, ATR15m, delta, lot, spread, OI — missing numbers never pass), evidence (every cited value in the
 * packet), sides (SL protective, targets beyond entry in order, pullback below price for a CE / above for a PE),
 * anti-chase (BREAKOUT_TRIGGER / MARKET_NOW within 1.5 × ATR15m of a cited packetLevels level, never LTP / strike / OI / volume), R:R to T1 ≥ 1.2,
 * liquidity (spread ≤ 2 %, OI ≥ minOi), intraday validUntil, and SL distance × |delta| × lot ≤ ceiling.
 * NO_TRADE has nothing to veto (ok).
 */
export function checkSetup(reply: SetupReply, ctx: SetupCheckContext): SetupCheckResult {
  if (reply.decision === 'NO_TRADE') return { ok: true };
  const s = reply.setup;
  if (reply.decision !== 'SETUP' || !s) return fail('malformed', 'SETUP without a setup body');
  if (s.side !== 'BUY' || s.instrument?.kind !== 'OPT' || (s.instrument.optionType !== 'CE' && s.instrument.optionType !== 'PE')) {
    return fail('not_option_buy', `v1 is option BUYS only (got ${String(s.side)} ${String(s.instrument?.kind)} ${String(s.instrument?.optionType)})`);
  }
  const shape = shapeError(s);
  if (shape) return fail('malformed', shape);

  // Missing data is a NO_TRADE with its reason — never a setup on absent numbers.
  const { ltpUnderlying: ltp, atr15m: atr, delta, lotSize: lot, spreadPct, oi } = ctx;
  if (!positive(ltp)) return fail('ltp_unavailable', 'no underlying LTP');
  if (!positive(atr)) return fail('atr_unavailable', 'no 15m ATR');
  if (!finite(delta) || delta === 0) return fail('delta_unavailable', 'no option delta');
  if (!positive(lot)) return fail('lot_unavailable', 'no lot size');
  if (!finite(spreadPct) || spreadPct < 0) return fail('spread_unavailable', 'no option bid/ask spread');
  if (!finite(oi) || oi < 0) return fail('oi_unavailable', 'no option OI');

  const idx = indexPacket(ctx.packet);
  if (s.evidence.length === 0) return fail('no_evidence', 'a setup must cite packet numbers');
  const bad = badEvidence(s.evidence, idx);
  if (bad) return fail('evidence_not_in_packet', `"${bad.fact}" = ${bad.value} (${bad.source}) is not in the packet`);

  const { entry } = s;
  // The cited level must be a real level (day / prior / 60d high-low, prior close, a 15m swing, VWAP) — never the
  // LTP, a strike, OI or volume, which would let any entry "anchor" to itself and beat anti-chase.
  const anchored = entry.type !== 'LIMIT_PULLBACK';
  if (entry.level === null) {
    if (anchored) return fail('level_not_a_level', `${entry.type} cites no level`);
  } else if (!packetLevels(ctx.packet, ltp).has(r2(entry.level))) {
    return fail(
      'level_not_a_level',
      `${entry.type} level ${entry.level} is not a packet level (day/prior/60d high-low, prior close, 15m swing, VWAP) or equals LTP ${ltp}`,
    );
  }

  const bull = s.instrument.optionType === 'CE';
  const dir = bull ? 1 : -1;
  // Expected fill (R:R) and worst fill (loss ceiling) on the underlying.
  const expected = entry.type === 'LIMIT_PULLBACK' ? (entry.low + entry.high) / 2 : entry.type === 'BREAKOUT_TRIGGER' ? (entry.trigger as number) : ltp;
  const worst =
    entry.type === 'MARKET_NOW' ? ltp
    : entry.type === 'BREAKOUT_TRIGGER' ? (bull ? Math.max(entry.high, entry.trigger as number) : Math.min(entry.low, entry.trigger as number))
    : bull ? entry.high : entry.low;
  const nearEdge = entry.type === 'MARKET_NOW' ? ltp : entry.type === 'BREAKOUT_TRIGGER' ? (bull ? Math.min(entry.low, entry.trigger as number) : Math.max(entry.high, entry.trigger as number)) : bull ? entry.low : entry.high;

  // SL protective: beyond every possible fill (below the zone for a CE, above it for a PE).
  if (dir * (nearEdge - s.sl) <= 0) return fail('sl_wrong_side', `SL ${s.sl} is not ${bull ? 'below' : 'above'} the entry ${nearEdge}`);
  // Targets beyond the expected fill, nearest first.
  if (s.targets.length === 0) return fail('targets_wrong_side', 'no targets');
  for (let i = 0; i < s.targets.length; i++) {
    const prev = i === 0 ? expected : s.targets[i - 1];
    if (dir * (s.targets[i] - prev) <= 0) return fail('targets_wrong_side', `target ${s.targets[i]} is not ${bull ? 'above' : 'below'} ${r2(prev)}`);
  }

  if (entry.type === 'LIMIT_PULLBACK') {
    // A pullback waits for the market to come back: wholly below the price for a CE, above it for a PE.
    if (bull ? entry.high >= ltp : entry.low <= ltp) {
      return fail('pullback_wrong_side', `pullback ${entry.low}–${entry.high} is not ${bull ? 'below' : 'above'} LTP ${ltp}`);
    }
  } else {
    const at = entry.type === 'MARKET_NOW' ? ltp : (entry.trigger as number);
    const dist = Math.abs(at - (entry.level as number));
    if (dist > ANTI_CHASE_ATR * atr + EPS) {
      return fail('anti_chase', `${entry.type} ${at} is ${r2(dist)} (${r2(dist / atr)} × ATR15m ${atr}) from level ${entry.level}; max ${ANTI_CHASE_ATR} × ATR`);
    }
  }

  const risk = dir * (expected - s.sl);
  const rr = (dir * (s.targets[0] - expected)) / risk;
  if (rr < MIN_REWARD_RISK - EPS) return fail('rr_below_min', `R:R to T1 ${r2(rr)} (entry ${r2(expected)}, SL ${s.sl}, T1 ${s.targets[0]}) < ${MIN_REWARD_RISK}`);

  if (spreadPct > MAX_SPREAD_PCT + EPS) return fail('spread_too_wide', `option spread ${spreadPct}% > ${MAX_SPREAD_PCT}%`);
  if (oi < ctx.minOi) return fail('oi_too_low', `option OI ${oi} < ${ctx.minOi}`);

  const mcx = String(ctx.exchange ?? '').trim().toUpperCase() === 'MCX';
  const last = mcx ? MCX_LAST_VALID : NSE_LAST_VALID;
  if (s.validUntil.trim() > last) return fail('valid_until_after_close', `validUntil ${s.validUntil} is after ${last} IST (intraday only)`);

  const ceiling = ctx.ceiling ?? DEFAULT_SETUP_CEILING_RUPEES;
  const slDistance = dir * (worst - s.sl);
  const rupees = r2(slDistance * Math.abs(delta) * lot);
  if (rupees > ceiling + EPS) {
    return fail('sl_too_wide', `stop too wide for 1 lot: (${r2(worst)} − ${s.sl}) × |${delta}| × ${lot} = ₹${rupees} > ceiling ₹${ceiling}`);
  }
  return { ok: true };
}
