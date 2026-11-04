import { mcxUnderlyingOf } from '@td/shared';
import { hardLossConfig } from '../../modules/exit-discipline/hard-floor';

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

export function lossLimitFor(underlying: string | null, env: Env = process.env): LossLimit {
  // The defaults are hard-floor.ts's own parse (one source of truth for HARD_LOSS_EXIT_RUPEES / _CAP_RUPEES).
  const { limit, cap } = hardLossConfig(env);
  const key = underlyingKey(underlying);
  const listed = key !== null ? parseLossLimitsByUnderlying(env.HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING)[key] : undefined;
  if (listed !== undefined) return { limit: limit === null ? null : listed, cap: listed };
  return { limit, cap };
}
