import { contractValueFactor, mcxUnderlyingOf } from '@td/shared';
import { MINI_OF, miniSymbolFor } from '../../signal-trader/domain/mini-swap';

/**
 * RE-ENTRY WATCH — LIVE SIZE (docs/superpowers/specs/2026-11-23-reentry-live-design.md §3 #3/#4/#13, §6a.1, §6a.6).
 * Pure. Called only after liveGate said live.
 *
 *  - FULL: exactly 1 full lot (never more) when its risk (entry − SL) × lotSize × value factor ≤ the fixed cap
 *    (₹2,000, §6a.1 — no per-underlying override) AND the funds check said yes (true; null = unknown = no).
 *  - MINI (MCX only — GOLD→GOLDM, CRUDEOIL→CRUDEOILM, NATURALGAS→NATGASMINI; SILVER has none): when the full lot
 *    fails risk or funds, lots = min(⌊cap / per-mini-lot risk⌋, the most the funds allow, miniMaxLots), ≥ 1.
 *  - NONE: RISK_OVER_LIMIT (full over the cap, no mini), NO_FUNDS (funds short/unknown, no mini or no mini lot
 *    fits the funds), NO_SIZE (bad / unreadable numbers, or not even 1 mini lot fits the cap).
 *
 * Rupee risk uses the MCX contract value factor (GOLD ₹100/pt/lot with master lotSize 1). A commodity symbol the
 * factor table does not know would be sized at factor 1 (100× too small for GOLD) — so it is NO_SIZE instead.
 */
export type LiveSize =
  | { kind: 'FULL'; lots: 1; riskRupees: number }
  | { kind: 'MINI'; miniSymbol: string; lots: number; riskRupees: number }
  | { kind: 'NONE'; limit: 'RISK_OVER_LIMIT' | 'NO_FUNDS' | 'NO_SIZE'; detail: string };

export interface LiveSizeInput {
  underlying: string;
  fullSymbol: string;
  /** Planned entry (limit) premium of the full contract. */
  entry: number;
  /** Planned SL premium of the full contract. */
  sl: number;
  /** Master lot size of the full contract. */
  lotSize: number;
  /** The funds check for 1 full lot: true fits, false short, null unknown (⇒ not fit). */
  fundsOkFull: boolean | null;
  /** The mini contract, already priced; null = no mini (or the fallback is off). */
  mini: { symbol: string; lotSize: number; entry: number; sl: number; fundsOkLots: (lots: number) => boolean | null } | null;
  /** Fixed ₹ cap per order (ReentryLiveLimits.riskRupees). */
  riskCapRupees: number;
  /** SIGNAL_MINI_MAX_LOTS. */
  miniMaxLots: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** ₹ value factor for one unit of a contract on this underlying; null = an MCX contract the table does not know. */
function factorFor(underlying: string, symbol: string): number | null {
  const isMcx = mcxUnderlyingOf(underlying) === underlying;
  if (!isMcx) return 1;
  const name = mcxUnderlyingOf(symbol);
  if (!name) return null;
  return contractValueFactor('MCX', name);
}

export function sizeLiveReentry(i: LiveSizeInput): LiveSize {
  const none = (limit: 'RISK_OVER_LIMIT' | 'NO_FUNDS' | 'NO_SIZE', detail: string): LiveSize => ({ kind: 'NONE', limit, detail });
  const und = String(i?.underlying ?? '').trim().toUpperCase();
  const sym = String(i?.fullSymbol ?? '').trim().toUpperCase();
  const cap = i?.riskCapRupees;

  if (!pos(cap)) return none('NO_SIZE', `risk cap ${cap} unreadable`);
  if (!und || !sym) return none('NO_SIZE', 'no underlying / symbol');
  if (!pos(i.entry) || !(typeof i.sl === 'number' && Number.isFinite(i.sl) && i.sl >= 0) || !(i.sl < i.entry)) {
    return none('NO_SIZE', `${sym}: entry ${i.entry} / SL ${i.sl} unreadable (SL must be below the entry)`);
  }
  if (!(Number.isInteger(i.lotSize) && i.lotSize >= 1)) return none('NO_SIZE', `${sym}: lot size ${i.lotSize} unreadable`);
  const fullFactor = factorFor(und, sym);
  if (fullFactor === null || (mcxUnderlyingOf(und) === und && mcxUnderlyingOf(sym) !== und)) {
    return none('NO_SIZE', `${sym}: contract value of ${und} unknown — not sized`);
  }

  const fullRisk = r2((i.entry - i.sl) * i.lotSize * fullFactor);
  const riskOver = fullRisk > cap;
  const fundsOk = i.fundsOkFull === true;
  if (!riskOver && fundsOk) return { kind: 'FULL', lots: 1, riskRupees: fullRisk };

  const fullWhy = riskOver
    ? `1 lot ${sym} risks ${rs(fullRisk)} > ${rs(cap)}`
    : i.fundsOkFull === false
      ? `1 lot ${sym} does not fit the funds`
      : `funds for 1 lot ${sym} unknown`;
  const fullLimit: 'RISK_OVER_LIMIT' | 'NO_FUNDS' = riskOver ? 'RISK_OVER_LIMIT' : 'NO_FUNDS';

  // MCX mini fallback (§3 #3, §6a.6).
  const miniName = MINI_OF[und] ?? null;
  if (!miniName || !i.mini) return none(fullLimit, `${fullWhy}${miniName ? '; no mini priced' : '; no mini for ' + und}`);
  const m = i.mini;
  const mSym = String(m.symbol ?? '').trim().toUpperCase();
  const expected = miniSymbolFor(sym, und);
  if (!expected || mSym !== expected) return none('NO_SIZE', `${fullWhy}; mini ${m.symbol} is not ${expected ?? `a ${miniName} of ${sym}`}`);
  if (!pos(m.entry) || !(typeof m.sl === 'number' && Number.isFinite(m.sl) && m.sl >= 0) || !(m.sl < m.entry) || !(Number.isInteger(m.lotSize) && m.lotSize >= 1)) {
    return none('NO_SIZE', `${fullWhy}; mini ${mSym} entry ${m.entry} / SL ${m.sl} / lot ${m.lotSize} unreadable`);
  }
  const maxLots = i.miniMaxLots;
  if (!(Number.isInteger(maxLots) && maxLots >= 1)) return none('NO_SIZE', `${fullWhy}; mini max lots ${maxLots} unreadable`);
  const mFactor = factorFor(und, mSym);
  if (mFactor === null || mcxUnderlyingOf(mSym) !== miniName) return none('NO_SIZE', `${fullWhy}; contract value of ${mSym} unknown`);

  const perLot = (m.entry - m.sl) * m.lotSize * mFactor;
  const byRisk = Math.floor(cap / perLot);
  const top = Math.min(byRisk, maxLots);
  if (!(top >= 1)) return none('NO_SIZE', `${fullWhy}; 1 lot ${mSym} risks ${rs(perLot)} > ${rs(cap)}`);
  for (let lots = top; lots >= 1; lots--) {
    let ok: boolean | null;
    try {
      ok = m.fundsOkLots(lots);
    } catch {
      ok = null;
    }
    if (ok === true) return { kind: 'MINI', miniSymbol: mSym, lots, riskRupees: r2(perLot * lots) };
  }
  return none('NO_FUNDS', `${fullWhy}; not even 1 lot ${mSym} fits the funds (or funds unknown)`);
}
