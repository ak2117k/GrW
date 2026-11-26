import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import { instrumentClass } from '../../../common/utils/loss-limit';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { floorToTick } from '../../signal-trader/domain/gate';
import type { DeskManagerConfig } from '../desk-manager.config';

/**
 * THE MANAGER'S PER-TRADE RISK (desk spec "Decided after the builder check"). The manager's stop is on the
 * UNDERLYING; the order needs a premium stop and the class ceiling needs rupees. Pure.
 */
export type OpenSide = 'BUY_CE' | 'BUY_PE' | 'BUY_FUT';
export type StrikePolicy = 'ATM' | 'ITM1' | 'OTM1' | number;
export type ExpiryPolicy = 'NEAREST' | 'NEXT';

/** Delta when the chain/greeks did not give one (spec: ATM 0.5, ITM1 0.6, OTM1 0.4; futures 1). */
export function defaultDelta(side: OpenSide, strikePolicy: StrikePolicy): number {
  if (side === 'BUY_FUT') return 1;
  if (strikePolicy === 'ITM1') return 0.6;
  if (strikePolicy === 'OTM1') return 0.4;
  return 0.5;
}

/**
 * Estimated rupee loss of 1 lot if the underlying goes from entry to stop:
 * |entry − stop| × delta × lotQty × valueFactor + spread × lotQty × valueFactor.
 * (The spread is in premium points, so it takes the contract's rupee factor too; 1 off MCX.)
 */
export function estimatePremiumLoss(i: {
  side: OpenSide;
  strikePolicy: StrikePolicy;
  underlyingEntry: number;
  underlyingStop: number;
  lotQty: number;
  valueFactor: number;
  delta: number | null;
  spread: number;
}): number {
  const vf = i.valueFactor > 0 ? i.valueFactor : 1;
  const delta = i.delta !== null && Number.isFinite(i.delta) && i.delta > 0 ? Math.min(Math.abs(i.delta), 1) : defaultDelta(i.side, i.strikePolicy);
  const move = Math.abs(i.underlyingEntry - i.underlyingStop);
  const spread = Number.isFinite(i.spread) && i.spread > 0 ? i.spread : 0;
  return Math.round((move * delta * i.lotQty * vf + spread * i.lotQty * vf) * 100) / 100;
}

/** The spread the estimate assumes when no depth is read: max(one tick, 1% of the premium). */
export function estimateSpread(premium: number, tick: number): number {
  const t = tick > 0 ? tick : 0.05;
  return Math.max(t, Math.round(premium * 0.01 * 100) / 100);
}

/** The premium stop: entry premium − estimated loss / (lotQty × valueFactor), floored at one tick. */
export function premiumStop(i: { entryPremium: number; loss: number; lotQty: number; valueFactor: number; tick: number }): number {
  const tick = i.tick > 0 ? i.tick : 0.05;
  const per = i.lotQty * (i.valueFactor > 0 ? i.valueFactor : 1);
  const raw = per > 0 ? i.entryPremium - i.loss / per : 0;
  return Math.max(tick, floorToTick(raw, tick));
}

/** Minis read their metal's ceiling when the table has no mini key (loss-limit classCeilingFor rule). */
const MINI_FALLBACK: Record<string, string> = { GOLD_MINI: 'GOLD', SILVER_MINI: 'SILVER' };

/**
 * The class ceiling in rupees for a manager trade (same classes as common/utils/loss-limit instrumentClass),
 * from `cfg.ceilings`. A class with no ceiling (OTHER: cash, unknown) ⇒ 0, i.e. every OPEN is refused.
 */
export function ceilingFor(underlying: string, exchange: string, symbol: string, cfg: Pick<DeskManagerConfig, 'ceilings'>): number {
  const cls = instrumentClass(symbol || underlying, exchange);
  if (cls === 'OTHER') return 0;
  const v = cfg.ceilings[cls] ?? (MINI_FALLBACK[cls] ? cfg.ceilings[MINI_FALLBACK[cls]] : undefined);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
function ymdLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type PickResult = { ok: true; strike: number | null; expiry: string } | { ok: false; reason: string };

/**
 * The strike and expiry for a manager OPEN from raw Angel scrip-master rows (never a token).
 * Expiry: NEAREST / NEXT live expiry after today (never the expiry-day contract, as the entry engine).
 * Strike: ATM = nearest to spot; ITM1 / OTM1 = one listed strike in / out of the money from ATM
 * (CE: ITM is below; PE: ITM is above); a number = that listed strike. Futures: strike null.
 */
export function pickContractSpec(
  master: readonly unknown[],
  i: { underlying: string; side: OpenSide; strikePolicy: StrikePolicy; expiryPolicy: ExpiryPolicy; spot: number },
  today: Date,
): PickResult {
  const name = up(i.underlying);
  const kind = i.side === 'BUY_CE' ? 'CE' : i.side === 'BUY_PE' ? 'PE' : 'FUT';
  const seg = segmentFor({ underlying: name, instrumentKind: kind });
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const rows = (master as Row[]).filter((r) => r && up(r.exch_seg) === seg && up(r.name) === name);
  const live = rows
    .filter((r) => (kind === 'FUT' ? /^FUT/.test(up(r.instrumenttype)) : /^OPT/.test(up(r.instrumenttype)) && up(r.symbol).endsWith(kind)))
    .map((r) => ({ expiry: parseMasterExpiry(r.expiry), strike: parseMasterStrike(r.strike) }))
    .filter((x): x is { expiry: Date; strike: number | null } => x.expiry !== null && x.expiry >= endOfToday);
  if (live.length === 0) return { ok: false, reason: `no live ${seg} ${name} ${kind} contracts after today in the instrument master` };
  const expiries = [...new Set(live.map((x) => x.expiry.getTime()))].sort((a, b) => a - b);
  const pick = i.expiryPolicy === 'NEXT' ? expiries[1] : expiries[0];
  if (pick === undefined) return { ok: false, reason: `no NEXT expiry listed for ${name} ${kind}` };
  const expiry = ymdLocal(new Date(pick));
  if (kind === 'FUT') return { ok: true, strike: null, expiry };

  const strikes = [...new Set(live.filter((x) => x.expiry.getTime() === pick).map((x) => x.strike).filter((s): s is number => s !== null && s > 0))].sort((a, b) => a - b);
  if (strikes.length === 0) return { ok: false, reason: `no strikes listed for ${name} ${kind} ${expiry}` };
  if (typeof i.strikePolicy === 'number') {
    const want = i.strikePolicy;
    return strikes.some((s) => Math.abs(s - want) < 1e-6) ? { ok: true, strike: want, expiry } : { ok: false, reason: `strike ${want} is not listed for ${name} ${kind} ${expiry}` };
  }
  if (!(i.spot > 0)) return { ok: false, reason: 'no underlying price for the ATM strike' };
  let atmIdx = 0;
  for (let k = 1; k < strikes.length; k++) if (Math.abs(strikes[k] - i.spot) < Math.abs(strikes[atmIdx] - i.spot)) atmIdx = k;
  if (i.strikePolicy === 'ATM') return { ok: true, strike: strikes[atmIdx], expiry };
  // CE: in the money = a lower strike; PE: a higher strike.
  const itmStep = kind === 'CE' ? -1 : 1;
  const step = i.strikePolicy === 'ITM1' ? itmStep : -itmStep;
  const s = strikes[atmIdx + step];
  return s === undefined ? { ok: false, reason: `no ${i.strikePolicy} strike next to ATM ${strikes[atmIdx]} for ${name} ${kind} ${expiry}` } : { ok: true, strike: s, expiry };
}
