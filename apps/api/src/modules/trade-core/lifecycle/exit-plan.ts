import type { OrderSide } from '../execution/execution.types';
import { istDate } from '../execution/ledger-math';
import type { LimitInForce } from '../risk-wall/risk-wall.types';
import type { StopBlock, StrategyBlocks, TargetBlock, Vehicle } from '../strategies/blocks/block-types';
import type { ExitPlan, OptionPlan, UnderlyingRef } from './lifecycle.types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Half-up to the paisa. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The initial stop distance, % of the reference price (spec §4.1). The ATR form is the
 * silo's rule (adaptive-stop-math.ts resolveStop): multiple × ATR, floored at minPct (also
 * when there is no usable ATR) and capped at maxPct. Exported so M5's
 * CoreEntryIntent.stopPrice and this plan agree (drift D11).
 */
export function resolveStopPct(stop: StopBlock, refPrice: number, atr: number | null): number {
  if (stop.kind === 'fixedPct') return stop.pct;
  const dist = finite(atr) && atr > 0 ? stop.multiple * atr : 0;
  const pct = refPrice > 0 ? (dist / refPrice) * 100 : 0;
  if (!(pct > 0) || pct < stop.minPct) return stop.minPct;
  return pct > stop.maxPct ? stop.maxPct : pct;
}

export function resolveTargetPct(target: TargetBlock, stopPct: number): number {
  return target.kind === 'fixedPct' ? target.pct : target.ratio * stopPct;
}

/** The contract M5 resolved (drift D10): M4 never picks strikes. */
export interface OptionOpen {
  optionType: 'CE' | 'PE';
  /** IST date, YYYY-MM-DD. */
  expiry: string;
  underlyingRef: UnderlyingRef | null;
  underlyingStopPrice: number | null;
}

export interface PlanInput {
  blocks: StrategyBlocks;
  vehicle: Vehicle;
  side: OrderSide;
  refPrice: number;
  atr: number | null;
  /** The verdict's limits snapshot. */
  limits: readonly LimitInForce[];
  option: OptionOpen | null;
  now: Date;
}

export type PlanResult = { ok: true; plan: ExitPlan } | { ok: false; error: string };

const fail = (error: string): PlanResult => ({ ok: false, error });
const limitValue = (limits: readonly LimitInForce[], key: string, scope: string): string | null =>
  limits.find((l) => l.key === key && l.scope === scope)?.value ?? null;

/** Spec §7.1: the exit rules, frozen at entry. Fails closed on anything it cannot plan. */
export function buildExitPlan(i: PlanInput): PlanResult {
  const b = i.blocks;
  if (b.vehicle.kind !== i.vehicle) return fail(`the version trades ${b.vehicle.kind}, not ${i.vehicle}`);
  if (!finite(i.refPrice) || i.refPrice <= 0) return fail('refPrice must be above 0');
  if (i.atr !== null && (!finite(i.atr) || i.atr < 0)) return fail('atr must be a number of 0 or more, or null');
  const squareOffHhmm = limitValue(i.limits, 'squareOffTime', i.vehicle);
  if (squareOffHhmm === null || !HHMM.test(squareOffHhmm)) return fail(`squareOffTime@${i.vehicle} is missing from the limits snapshot`);
  let mtfMaxHoldDays: number | null = null;
  if (i.vehicle === 'MTF') {
    const n = Number(limitValue(i.limits, 'mtfMaxHoldDays', 'MTF') ?? Number.NaN);
    if (!Number.isSafeInteger(n) || n < 1) return fail('mtfMaxHoldDays@MTF is missing from the limits snapshot');
    mtfMaxHoldDays = n;
  }
  let stopPct = resolveStopPct(b.stop, i.refPrice, i.atr);
  let option: OptionPlan | null = null;
  if (b.vehicle.kind === 'OPTIONS_BUY') {
    const o = i.option;
    if (!o) return fail('an OPTIONS_BUY position needs its contract (optionType, expiry)');
    if (i.side !== 'BUY') return fail('options are bought only');
    if (o.optionType !== 'CE' && o.optionType !== 'PE') return fail('optionType must be CE or PE');
    if (!DAY.test(o.expiry)) return fail('option expiry must be YYYY-MM-DD');
    if ((o.underlyingRef === null) !== (o.underlyingStopPrice === null)) return fail('an underlying stop needs both underlyingRef and underlyingStopPrice');
    if (o.underlyingStopPrice !== null && !(finite(o.underlyingStopPrice) && o.underlyingStopPrice > 0)) return fail('underlyingStopPrice must be above 0');
    stopPct = Math.min(stopPct, b.vehicle.premiumStopPct);
    option = {
      optionType: o.optionType,
      expiry: o.expiry,
      premiumStopPct: b.vehicle.premiumStopPct,
      thetaStop: { ...b.vehicle.thetaStop },
      expiryDayExitHhmm: b.vehicle.expiryDayExitHhmm,
      underlyingRef: o.underlyingRef ? { ...o.underlyingRef } : null,
      underlyingStopPrice: o.underlyingStopPrice,
    };
  } else if (i.option) {
    return fail('only OPTIONS_BUY takes an option contract');
  }
  if (!(stopPct > 0)) return fail('the stop distance must be above 0');
  return {
    ok: true,
    plan: {
      version: 1,
      vehicle: i.vehicle,
      side: i.side,
      stopPct,
      targetPct: resolveTargetPct(b.target, stopPct),
      trail: b.trail,
      partial: b.partial,
      timeExit: b.timeExit,
      atr: i.atr,
      squareOffHhmm,
      mtfMaxHoldDays,
      entryDay: istDate(i.now),
      option,
    },
  };
}

export interface ArmedLevels {
  stopPrice: number;
  targetPrice: number;
  /** The target-1 level (it also starts a trail that waits for the partial); null without a partial block. */
  partialPrice: number | null;
  /** Whole lots to sell at the partial; 0 when that would be nothing or everything. */
  partialQty: number;
}

/** Ruling L4: the levels from the entry average. */
export function armLevels(plan: ExitPlan, entryAvg: number, entryQty: number, lotSize: number): ArmedLevels {
  const dir = plan.side === 'BUY' ? 1 : -1;
  const at = (pct: number) => round2(entryAvg * (1 + (dir * pct) / 100));
  const stopPrice = round2(entryAvg * (1 - (dir * plan.stopPct) / 100));
  const targetPrice = at(plan.targetPct);
  if (plan.partial.kind === 'none') return { stopPrice, targetPrice, partialPrice: null, partialQty: 0 };
  const lots = Math.floor((entryQty * plan.partial.fraction) / lotSize) * lotSize;
  return { stopPrice, targetPrice, partialPrice: at(plan.partial.atPct), partialQty: lots > 0 && lots < entryQty ? lots : 0 };
}
