import { contractValueFactor } from '@td/shared';
import type { ResolvedContract } from './contract-resolver';
import type { EntryPlan } from './gate';

type Env = Record<string, string | undefined>;

/**
 * MCX MINI FALLBACK (owner 2026-11-19: "if there is a lack of money, can we go for the mini one, and how many
 * lots"). A full commodity lot often does not fit: one GOLD option lot needs ₹28k–₹84k of premium, one CRUDEOIL
 * lot ₹19k–₹27k, against ₹475–₹33.8k available on the short calls of 12–19 Nov. Each full contract below has a
 * mini that is exactly 1/10 of it, with options on the same strikes AND the same expiry, so the same call can be
 * traded smaller. SILVERM is left out: its options expire on a different day from SILVER's.
 */
export const MINI_OF: Readonly<Record<string, string>> = { GOLD: 'GOLDM', CRUDEOIL: 'CRUDEOILM', NATURALGAS: 'NATGASMINI' };

/** SIGNAL_MINI_FALLBACK (default on; off / false / 0 = never swap — the full lot or paper, as before). */
export function miniFallbackOn(env: Env = process.env): boolean {
  return !['off', 'false', '0'].includes(String(env.SIGNAL_MINI_FALLBACK ?? '').trim().toLowerCase());
}

/** SIGNAL_MINI_MAX_LOTS (default 5 = half a full lot, owner 2026-11-19; 1..10). */
export function miniMaxLots(env: Env = process.env): number {
  const n = Number(env.SIGNAL_MINI_MAX_LOTS);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5;
}

/** The mini's name for a full contract's tradingsymbol / underlying (null = no mini to fall back to). */
export function miniNameFor(underlying: string | null): string | null {
  return MINI_OF[String(underlying ?? '').trim().toUpperCase()] ?? null;
}

/** The mini's tradingsymbol: the full one with its name swapped (GOLD27NOV26120000PE → GOLDM27NOV26120000PE). */
export function miniSymbolFor(fullSymbol: string, underlying: string): string | null {
  const name = String(underlying).trim().toUpperCase();
  const mini = MINI_OF[name];
  const sym = String(fullSymbol).trim().toUpperCase();
  if (!mini || !sym.startsWith(name) || !/^\d/.test(sym.slice(name.length))) return null;
  return mini + sym.slice(name.length);
}

/** Why the full lot does not fit (null = it fits: no swap). */
export function fullLotMisfit(f: { fundsOk: boolean | null; riskRupees: number; cap: number }): 'funds' | 'risk' | null {
  if (f.fundsOk === false) return 'funds';
  if (f.riskRupees > f.cap) return 'risk';
  return null;
}

export type MiniSwap =
  | { ok: true; plan: EntryPlan; detail: string; byRisk: number; byFunds: number | null; maxLots: number; ratio: number }
  | { ok: false; reason: string };

/** The mini's premium must track the full's: a mini more than this far off is a bad print or a dead book. */
const MAX_PREMIUM_GAP = 0.2;

const onTick = (v: number, tick: number) => (tick > 0 ? Math.round(Math.round(v / tick) * tick * 1e6) / 1e6 : Math.round(v * 100) / 100);

/**
 * The full plan rebuilt on the mini (pure). Every premium level (limit, band, SL, targets) is moved by the ratio of
 * the two LIVE premiums, so the stop stays the same % away. Lots = the fewest of: what fits the per-trade loss cap,
 * what fits the available funds (premium + the funds buffer), SIGNAL_MINI_MAX_LOTS, and the judge's own number when
 * it gave one (it may take fewer, never more). Option BUYs only (the premium is the whole cost).
 */
export function planMini(i: {
  plan: EntryPlan;
  mini: ResolvedContract;
  /** The mini's live premium, read just now; null = no price → no swap (a thin book is not traded blind). */
  miniLtp: number | null;
  /** The full contract's live premium the plan was just checked against. */
  fullLtp: number;
  /** ₹ per-trade loss cap for the MINI (riskCapFor its own name). */
  cap: number;
  /** ₹ available (null = unknown: sized on risk only, as the full order would be sent). */
  available: number | null;
  fundsBufferPct: number;
  maxLots: number;
  judgeLots?: number | null;
}): MiniSwap {
  const { plan, mini } = i;
  if (plan.side !== 'BUY') return { ok: false, reason: 'mini fallback is for option BUYs only' };
  if (!(mini.lotSize >= 1)) return { ok: false, reason: `${mini.tradingsymbol} has no lot size in the master` };
  if (i.miniLtp === null || !(i.miniLtp > 0)) return { ok: false, reason: `no live price for ${mini.tradingsymbol}` };
  if (!(i.fullLtp > 0)) return { ok: false, reason: 'no live price for the full contract' };
  const ratio = i.miniLtp / i.fullLtp;
  if (Math.abs(ratio - 1) > MAX_PREMIUM_GAP) {
    return { ok: false, reason: `${mini.tradingsymbol} ${i.miniLtp} is ${Math.round(Math.abs(ratio - 1) * 100)}% off ${plan.tradingsymbol} ${i.fullLtp} (> ${MAX_PREMIUM_GAP * 100}%)` };
  }
  const tick = mini.tickSize;
  const scale = (v: number) => onTick(v * ratio, tick);
  const limitPrice = Math.max(scale(plan.limitPrice), onTick(i.miniLtp, tick));
  const sl = scale(plan.sl);
  if (!(sl < limitPrice)) return { ok: false, reason: `scaled SL ${sl} is not below the limit ${limitPrice}` };
  const vf = contractValueFactor(mini.exchange, mini.tradingsymbol);
  const perLotRisk = (limitPrice - sl) * mini.lotSize * vf;
  const perLotCost = limitPrice * mini.lotSize * vf * (1 + i.fundsBufferPct / 100);
  const byRisk = Math.floor(i.cap / perLotRisk);
  const byFunds = i.available === null ? null : Math.floor(i.available / perLotCost);
  const judge = i.judgeLots !== undefined && i.judgeLots !== null && i.judgeLots >= 1 ? Math.floor(i.judgeLots) : null;
  const lots = Math.min(byRisk, byFunds ?? Infinity, i.maxLots, judge ?? Infinity);
  if (!(lots >= 1)) {
    const why = byRisk < 1 ? `1 mini lot risks ₹${Math.round(perLotRisk)} > cap ₹${i.cap}` : `1 mini lot needs ₹${Math.round(perLotCost)} > available ₹${Math.round(i.available ?? 0)}`;
    return { ok: false, reason: why };
  }
  const swapped: EntryPlan = {
    ...plan,
    exchange: mini.exchange,
    token: mini.token,
    tradingsymbol: mini.tradingsymbol,
    lotSize: mini.lotSize,
    tickSize: mini.tickSize,
    ltp: i.miniLtp,
    bandLow: Math.min(scale(plan.bandLow), i.miniLtp),
    bandHigh: Math.max(scale(plan.bandHigh), limitPrice),
    limitPrice,
    sl,
    targets: plan.targets.map(scale),
    lots,
    qty: lots * mini.lotSize,
    riskRupees: Math.round(perLotRisk * lots * 100) / 100,
  };
  const detail =
    `${plan.tradingsymbol} → ${mini.tradingsymbol} × ${lots} lot(s) @ ${limitPrice}, SL ${sl}, risk ₹${Math.round(perLotRisk * lots)}` +
    ` (by risk ${byRisk}, by funds ${byFunds ?? 'unknown'}, cap ${i.maxLots}${judge !== null ? `, judge ${judge}` : ''})`;
  return { ok: true, plan: swapped, detail, byRisk, byFunds, maxLots: i.maxLots, ratio };
}
