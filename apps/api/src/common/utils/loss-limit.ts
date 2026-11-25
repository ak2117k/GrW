import { mcxUnderlyingOf } from '@td/shared';
import { hardLossConfig } from '../../modules/exit-discipline/hard-floor';
import { hardLossAbsRupees } from '../../modules/exit-discipline/chart-read';
import { INDEX_ALIASES } from '../../modules/signal-intake/domain/vocabulary';

/**
 * PER-UNDERLYING HARD LOSS LIMIT (owner 2026-11-04: "GOLD loss limit ₹7.5k"). Pure.
 *
 * MCX GOLD is ₹100 per point per lot (contract-value.ts): one ordinary GOLD option swing is worth more
 * than the ₹2k → ₹3k per-trade loss exit, so a GOLD trade was either sold inside noise or blocked at
 * entry by the risk cap. GOLD gets its own figure; everything else keeps ₹2k → ₹3k.
 *
 *   HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING  `GOLD:7500,SILVER:5000`. Unset / empty = the code default
 *                                        `GOLD:7500`. `off` = no per-underlying figures (rollback).
 *                                        Junk entries are ignored, valid ones kept.
 *
 * A listed underlying gets limit = cap = the listed value (no ₹limit–₹cap noise band: the plain rule).
 * Anything else falls back to HARD_LOSS_EXIT_RUPEES (limit) / HARD_LOSS_CAP_RUPEES (cap, default 3000,
 * 0 = no cap). HARD_LOSS_EXIT_RUPEES stays the master switch: unset / 0 ⇒ limit null for EVERY
 * underlying (the hard loss exit is off), but a listed underlying's cap still reads its figure so the
 * entry risk check (signal-trader gate) sizes GOLD against ₹7,500.
 *
 * Names match exactly after mcxUnderlyingOf, so GOLDM, GOLDGUINEA and SILVER100 are NOT GOLD / SILVER;
 * a non-MCX name is compared upper-case exactly (NIFTY ≠ NIFTY09NOV2623750PE).
 */
export const HARD_LOSS_BY_UNDERLYING_DEFAULT = 'GOLD:7500';

type Env = Record<string, string | undefined>;

export interface LossLimit {
  limit: number | null;
  cap: number | null;
}

/** `NAME:rupees,...` → { NAME: rupees }. An entry that is not exactly one name and one positive number is dropped. */
export function parseLossLimitsByUnderlying(raw: string | undefined): Record<string, number> {
  const s = String(raw ?? '').trim();
  const src = s === '' ? HARD_LOSS_BY_UNDERLYING_DEFAULT : s;
  if (src.toLowerCase() === 'off') return {};
  const out: Record<string, number> = {};
  for (const part of src.split(',')) {
    const bits = part.split(':');
    if (bits.length !== 2) continue;
    const name = bits[0].trim().toUpperCase();
    const v = bits[1].trim();
    const n = v === '' ? NaN : Number(v);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    out[name] = n;
  }
  return out;
}

/** The key a name or tradingsymbol is looked up by: the MCX underlying, else the upper-cased name. */
function underlyingKey(underlying: string | null | undefined): string | null {
  const s = String(underlying ?? '').trim().toUpperCase();
  if (!s) return null;
  return mcxUnderlyingOf(s) ?? s;
}

/**
 * CATASTROPHE FLOOR — PER-CLASS CEILINGS (owner 2026-11-25, desk spec §5.3). Pure.
 *
 * The flat ₹2,000 loss exit sells instruments whose ordinary 15-minute swing is worth more than ₹2,000. With
 * the table on, a listed class keeps limit = HARD_LOSS_EXIT_RUPEES (₹2,000) and gets cap = its ceiling, so
 * hard-floor.ts's noise band is on: between −limit and −ceiling the trade exits only once the underlying is
 * HARD_LOSS_NOISE_N (3) × its 15-MINUTE noise unit (N15, see hardLossNoiseUnit) against it; at −ceiling it exits
 * unconditionally. This replaces, for a listed class, both HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING (GOLD's plain
 * ₹7,500) and the trade-value stops of lossLimitForTrade.
 *
 *   HARD_LOSS_CEILING_BY_CLASS  `INDEX_OPT:5000,STOCK_OPT:5000,GOLD:7500,SILVER:7500,GOLD_MINI:4000,SILVER_MINI:4000,MCX:5000`.
 *                               Unset / blank / `off` = no table = today's behaviour, exactly. Junk entries
 *                               (unknown class, OTHER, non-positive / non-numeric value, wrong shape) are
 *                               ignored, valid ones kept; no valid entry = no table. A class not listed keeps
 *                               today's figures. A bad table can only fall back to today's figures — never "no cap".
 *
 * MINIS (owner 2026-11-25): GOLDM ⇒ GOLD_MINI and SILVERM ⇒ SILVER_MINI, their own classes (₹4,000 vs the full
 * contract's ₹7,500). A table WITHOUT the mini key keeps the old behaviour: GOLD_MINI absent ⇒ a GOLDM position
 * reads the GOLD entry (SILVER_MINI absent ⇒ SILVER), exactly as when the minis were classed as their metal, so an
 * existing table neither loosens nor tightens. Neither the mini key nor the metal listed ⇒ today's figures.
 *
 * HARD_LOSS_EXIT_RUPEES stays the master switch (unset ⇒ limit null everywhere). The entry risk check
 * (signal-trader gate riskCapFor) does not read this table: widening the exit floor never lets bigger trades in.
 */
export const CEILING_CLASSES = ['INDEX_OPT', 'STOCK_OPT', 'GOLD', 'SILVER', 'GOLD_MINI', 'SILVER_MINI', 'MCX'] as const;
export type CeilingClass = (typeof CEILING_CLASSES)[number];
export type InstrumentClass = CeilingClass | 'OTHER';

/** `CLASS:rupees,...` → { CLASS: rupees }. Unset / blank / `off` → {}. Junk entries dropped. */
export function parseCeilingByClass(raw: string | undefined): Partial<Record<CeilingClass, number>> {
  const s = String(raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'off') return {};
  const out: Partial<Record<CeilingClass, number>> = {};
  for (const part of s.split(',')) {
    const bits = part.split(':');
    if (bits.length !== 2) continue;
    const name = bits[0].trim().toUpperCase() as CeilingClass;
    const v = bits[1].trim();
    const n = v === '' ? NaN : Number(v);
    if (!CEILING_CLASSES.includes(name) || !Number.isFinite(n) || n <= 0) continue;
    out[name] = n;
  }
  return out;
}

/** True when HARD_LOSS_CEILING_BY_CLASS holds at least one valid entry. */
export function ceilingTableOn(env: Env = process.env): boolean {
  return Object.keys(parseCeilingByClass(env.HARD_LOSS_CEILING_BY_CLASS)).length > 0;
}

/** Index underlyings with listed derivatives (signal-intake vocabulary INDEX_ALIASES keys), longest first. */
const INDEX_NAMES_LONGEST_FIRST = Object.keys(INDEX_ALIASES).sort((a, b) => b.length - a.length);
const isIndexName = (s: string): boolean =>
  INDEX_NAMES_LONGEST_FIRST.some((name) => {
    if (!s.startsWith(name)) return false;
    const next = s.charAt(name.length);
    return next === '' || (next >= '0' && next <= '9');
  });

/**
 * The ceiling class of a tradingsymbol (or underlying name) on an exchange.
 *  - MCX: GOLD ⇒ GOLD, SILVER ⇒ SILVER, GOLDM ⇒ GOLD_MINI, SILVERM ⇒ SILVER_MINI (classCeilingFor falls a mini
 *    back to its metal's entry when the mini key is not listed); every other MCX name (GOLDGUINEA, GOLDPETAL,
 *    SILVERMIC, CRUDEOIL, …) ⇒ MCX.
 *  - NFO / BFO: an index name (INDEX_ALIASES keys) followed by a digit or nothing ⇒ INDEX_OPT, else STOCK_OPT.
 *    Futures on those exchanges classify by the same rule.
 *  - Exchange unknown (null / blank): an MCX name or an index name is still classified; anything else ⇒ OTHER.
 *  - Anything else (cash NSE / BSE, empty symbol) ⇒ OTHER, which is never in the table (today's figures).
 */
export function instrumentClass(symbol: string | null | undefined, exchange: string | null | undefined): InstrumentClass {
  const s = String(symbol ?? '').trim().toUpperCase();
  if (!s) return 'OTHER';
  const ex = String(exchange ?? '').trim().toUpperCase();
  const mcx = mcxUnderlyingOf(s);
  if (ex === 'MCX' || (ex === '' && mcx !== null)) {
    if (mcx === 'GOLD') return 'GOLD';
    if (mcx === 'GOLDM') return 'GOLD_MINI';
    if (mcx === 'SILVER') return 'SILVER';
    if (mcx === 'SILVERM') return 'SILVER_MINI';
    return 'MCX';
  }
  const fno = ex === 'NFO' || ex === 'BFO';
  if ((fno || ex === '') && isIndexName(s)) return 'INDEX_OPT';
  return fno ? 'STOCK_OPT' : 'OTHER';
}

/** A mini class with no entry of its own reads its metal's entry (the pre-2026-11-25 classing). */
const MINI_FALLBACK: Partial<Record<CeilingClass, CeilingClass>> = { GOLD_MINI: 'GOLD', SILVER_MINI: 'SILVER' };

/**
 * The class ceiling in rupees when the table is on and lists this position's class; else null (today's figures).
 * GOLD_MINI / SILVER_MINI not listed ⇒ the GOLD / SILVER entry (never MCX), so a table written before the mini
 * classes existed means exactly what it meant then.
 */
export function classCeilingFor(symbol: string | null | undefined, exchange: string | null | undefined, env: Env = process.env): number | null {
  const cls = instrumentClass(symbol, exchange);
  if (cls === 'OTHER') return null;
  const table = parseCeilingByClass(env.HARD_LOSS_CEILING_BY_CLASS);
  const fallback = MINI_FALLBACK[cls];
  return table[cls] ?? (fallback !== undefined ? table[fallback] : undefined) ?? null;
}

/**
 * The noise unit the hard-loss band measures the underlying's move in, decided PER POSITION. The position's
 * class is listed in HARD_LOSS_CEILING_BY_CLASS ⇒ `n15` (ATR14 of the underlying's 15-minute session bars) — and
 * a missing N15 stays missing (null ⇒ hardLossReading's BAND_UNMEASURED: exit at the limit), never N1. Table off,
 * or the class not listed (a partial table, OTHER) ⇒ `n1`, the 1-minute unit, exactly as before 2026-11-25.
 */
export function usesN15Band(symbol: string | null | undefined, exchange: string | null | undefined, env: Env = process.env): boolean {
  return classCeilingFor(symbol, exchange, env) !== null;
}

export function hardLossNoiseUnit(
  env: Env, symbol: string | null | undefined, exchange: string | null | undefined, n1: number | null | undefined, n15: number | null | undefined,
): number | null {
  return usesN15Band(symbol, exchange, env) ? (n15 ?? null) : (n1 ?? null);
}

/**
 * The loss at which the loss-side chart check (exit-gate chart-confirm) stops holding: HARD_LOSS_ABS_RUPEES
 * (chart-read.ts, prod ₹3,500) today; with the table on and the class listed, the class ceiling — the chart
 * may hold to the ceiling, never past it.
 */
export function chartAbsLossRupees(symbol: string | null | undefined, exchange: string | null | undefined, env: Env = process.env): number {
  return classCeilingFor(symbol, exchange, env) ?? hardLossAbsRupees(env);
}

/** `exchange` is optional (positional before `env`); without it the class is inferred from the name (instrumentClass). */
export function lossLimitFor(underlying: string | null, env?: Env): LossLimit;
export function lossLimitFor(underlying: string | null, exchange: string | null | undefined, env?: Env): LossLimit;
export function lossLimitFor(underlying: string | null, a?: Env | string | null, b?: Env): LossLimit {
  const [exchange, env] = typeof a === 'object' && a !== null ? [null, a] : [a ?? null, b ?? process.env];
  // Catastrophe floor (2026-11-25): a listed class keeps the ₹limit and gets its ceiling as the cap (band on).
  const ceiling = classCeilingFor(underlying, exchange, env);
  if (ceiling !== null) return { limit: hardLossConfig(env).limit, cap: ceiling };
  return lossLimitBeforeCeilings(underlying, env);
}

/**
 * TODAY'S per-trade figures, blind to HARD_LOSS_CEILING_BY_CLASS: HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING, else
 * HARD_LOSS_EXIT_RUPEES / HARD_LOSS_CAP_RUPEES. The exit gate's HARD_MAX_LOSS reads this — the table moves the
 * sentinel's hard-loss exit only; moving the gate's hard-risk clause is a separate owner decision.
 */
export function lossLimitBeforeCeilings(underlying: string | null, env: Env = process.env): LossLimit {
  // The defaults are hard-floor.ts's own parse (one source of truth for HARD_LOSS_EXIT_RUPEES / _CAP_RUPEES).
  const { limit, cap } = hardLossConfig(env);
  const key = underlyingKey(underlying);
  const listed = key !== null ? parseLossLimitsByUnderlying(env.HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING)[key] : undefined;
  if (listed !== undefined) return { limit: limit === null ? null : listed, cap: listed };
  return { limit, cap };
}

/** Trade value (premium x quantity) from which a stock trade gets the wider stop. Upper quartile of real stock option trades, Oct-Nov 2026. */
export const HIGH_VALUE_TRADE_RUPEES_DEFAULT = 25_000;
export const HIGH_VALUE_EXIT_RUPEES_DEFAULT = 3_000;
const INDEX_DERIVATIVE = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYNXT50|SENSEX|BANKEX)\d/;

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * THE HARD RUPEE STOP BY TRADE VALUE (owner 2026-11-09: no risk-reward test at entry; the loss is capped at the exit).
 * An index derivative exits at HARD_LOSS_EXIT_RUPEES (2k). A stock or commodity trade worth at least
 * HARD_LOSS_HIGH_VALUE_TRADE_RUPEES exits at HARD_LOSS_HIGH_VALUE_EXIT_RUPEES (3k), a smaller one at 2k. All plain
 * stops: limit = cap, so no noise band. A listed underlying (GOLD) keeps its figure. A stock with no usable value
 * falls back to lossLimitFor, as does HARD_LOSS_BY_TRADE_VALUE=off (the rollback).
 */
export function lossLimitForTrade(symbol: string, tradeValue: number | null | undefined, env?: Env): LossLimit;
export function lossLimitForTrade(symbol: string, tradeValue: number | null | undefined, exchange: string | null | undefined, env?: Env): LossLimit;
export function lossLimitForTrade(symbol: string, tradeValue: number | null | undefined, a?: Env | string | null, b?: Env): LossLimit {
  const [exchange, env] = typeof a === 'object' && a !== null ? [null, a] : [a ?? null, b ?? process.env];
  // Catastrophe floor (2026-11-25): a class listed in HARD_LOSS_CEILING_BY_CLASS replaces the trade-value stops.
  if (classCeilingFor(symbol, exchange, env) !== null) return lossLimitFor(symbol, exchange, env);
  const base = lossLimitFor(symbol, exchange, env);
  if (base.limit === null || String(env.HARD_LOSS_BY_TRADE_VALUE ?? '').trim().toLowerCase() === 'off') return base;
  const key = underlyingKey(symbol);
  if (key !== null && parseLossLimitsByUnderlying(env.HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING)[key] !== undefined) return base;
  if (INDEX_DERIVATIVE.test(symbol.trim().toUpperCase())) return { limit: base.limit, cap: base.limit };
  if (typeof tradeValue !== 'number' || !Number.isFinite(tradeValue)) return base;
  const high = tradeValue >= positive(env.HARD_LOSS_HIGH_VALUE_TRADE_RUPEES, HIGH_VALUE_TRADE_RUPEES_DEFAULT);
  const rupees = high ? positive(env.HARD_LOSS_HIGH_VALUE_EXIT_RUPEES, HIGH_VALUE_EXIT_RUPEES_DEFAULT) : base.limit;
  return { limit: rupees, cap: rupees };
}
