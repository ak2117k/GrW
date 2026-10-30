import { parseMasterExpiry, parseMasterStrike } from '../../market-data/services/master-contract';
import { resolveContract, segmentFor, type ResolveResult } from '../../signal-trader/domain/contract-resolver';
import { ceilToTick, floorToTick, planEntry, type EntryPlan, type GateCheck } from '../../signal-trader/domain/gate';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import type { SignalView } from '../../signal-trader/domain/signal.types';

/**
 * The engine's contract and entry plan: the at-the-money option of the nearest live expiry (never the
 * expiry-day contract), then the signal-trader's own planEntry — the same EntryPlan a Telegram call
 * gets, from a synthetic "BUY <ATM> AT <LTP>" call with a premium-% stop and target. Paper sizing is
 * 1 lot (the risk cap is a warning in paper mode, exactly as for a Telegram paper trade). Pure.
 */
export const ENGINE_PLAN = Object.freeze({
  /** Stop and first target on the option premium. */
  slPremiumPct: 25,
  targetPremiumPct: 50,
  lots: 1,
});

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();

function ymdLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type AtmResult = { ok: true; strike: number; expiry: string } | { ok: false; reason: string };

/** The ATM strike of `kind` on the nearest live expiry after today, from raw Angel scrip-master rows. */
export function atmOption(master: readonly unknown[], underlying: string, kind: 'CE' | 'PE', spot: number, today: Date): AtmResult {
  if (!(spot > 0)) return { ok: false, reason: 'no underlying price for the ATM strike' };
  const seg = segmentFor({ underlying, instrumentKind: kind });
  const name = up(underlying);
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const opts = (master as Row[])
    .filter((r) => r && up(r.exch_seg) === seg && up(r.name) === name && /^OPT/.test(up(r.instrumenttype)) && up(r.symbol).endsWith(kind))
    .map((r) => ({ expiry: parseMasterExpiry(r.expiry), strike: parseMasterStrike(r.strike) }))
    // Never the expiry-day contract: it can lose its whole premium inside one engine trade.
    .filter((x): x is { expiry: Date; strike: number } => x.expiry !== null && x.expiry >= endOfToday && x.strike !== null && x.strike > 0);
  if (opts.length === 0) return { ok: false, reason: `no live ${seg} ${name} ${kind} contracts after today in the instrument master` };
  const nearest = Math.min(...opts.map((x) => x.expiry.getTime()));
  const strikes = [...new Set(opts.filter((x) => x.expiry.getTime() === nearest).map((x) => x.strike))];
  let best = strikes[0];
  for (const s of strikes) if (Math.abs(s - spot) < Math.abs(best - spot) || (Math.abs(s - spot) === Math.abs(best - spot) && s < best)) best = s;
  return { ok: true, strike: best, expiry: ymdLocal(new Date(nearest)) };
}

/** The synthetic call the plan is built from: BUY the ATM option AT its LTP, premium-% SL and T1. */
export function engineSignal(i: { decisionId: string; underlying: string; kind: 'CE' | 'PE'; strike: number; expiry: string; ltp: number; tick: number; at: Date }): SignalView {
  const sl = floorToTick(i.ltp * (1 - ENGINE_PLAN.slPremiumPct / 100), i.tick);
  const t1 = ceilToTick(i.ltp * (1 + ENGINE_PLAN.targetPremiumPct / 100), i.tick);
  return {
    id: i.decisionId,
    channelId: null,
    receivedAt: i.at,
    underlying: up(i.underlying),
    instrumentKind: i.kind,
    strike: i.strike,
    expiry: i.expiry,
    side: 'BUY',
    entryLow: i.ltp,
    entryHigh: i.ltp,
    entryType: 'AT',
    sl: sl > 0 ? sl : null,
    targets: [t1],
    qty: ENGINE_PLAN.lots,
    confidence: null,
    rawText: `entry-engine ${i.kind} ${i.underlying} ${i.strike} ${i.expiry}`,
    horizon: 'INTRADAY',
  };
}

/** The signal-trader config the engine plans with: paper, no learning mode, 1 lot. */
export function engineConfig(base: SignalTraderConfig): SignalTraderConfig {
  return { ...base, mode: 'paper', paperLearn: false, maxLots: ENGINE_PLAN.lots, defaultLots: ENGINE_PLAN.lots };
}

/** Resolve the ATM contract (signal-trader's resolver: refuses ambiguity) for the synthetic call. */
export function engineContract(master: readonly unknown[], s: Pick<SignalView, 'underlying' | 'instrumentKind' | 'strike' | 'expiry'>, today: Date): ResolveResult {
  return resolveContract(master, { ...(s as SignalView), side: 'BUY', entryLow: 0, entryHigh: 0, entryType: 'AT', sl: null, targets: [], qty: null, confidence: null, rawText: '', id: '', channelId: null, receivedAt: null }, today);
}

/** The plan (signal-trader planEntry) for the engine's call at `ltp`. */
export function planEngineEntry(i: { signal: SignalView; contract: ResolveResult; ltp: number | null; cfg: SignalTraderConfig }): { plan: EntryPlan | null; checks: GateCheck[] } {
  return planEntry({ signal: i.signal, contract: i.contract, ltp: i.ltp, engineSl: null, engineSlInfo: null, engineTargets: null }, engineConfig(i.cfg));
}
