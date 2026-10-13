import * as adaptiveGate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import type { EvaluatorParams, GateRef } from '../strategies/blocks/block-types';

/**
 * Drift D9 / O6: the named code gates a version's filters.gates may reference. Each wraps an existing
 * pure evaluator (spec §3: wrapped, not rewritten). An unknown key fails closed (GATE_UNKNOWN).
 */
export const ADAPTIVE_GATE_KEY = 'adaptive-stop-decision-gate';

export interface GateContext {
  entryPrice: number;
  now: Date;
  /** Hub candles over the last `days` calendar days, or null when unavailable. */
  candles(tf: Timeframe, days: number): Promise<HubCandle[] | null>;
}

export interface GateOutcome {
  key: string;
  pass: boolean;
  /** The evaluator could not judge (data gap). */
  skipped: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

interface GateEvaluator {
  evaluate(params: EvaluatorParams, ctx: GateContext): Promise<GateOutcome>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const toGateCandle = (c: HubCandle): adaptiveGate.GateCandle => ({ high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: new Date(c.ts) });

const adaptiveStopGate: GateEvaluator = {
  async evaluate(p, ctx) {
    const nearSupportPct = num(p.nearSupportPct);
    const rsiHot = num(p.rsiHot);
    const vwapExtPct = num(p.vwapExtPct);
    const days = num(p.srLookbackDays);
    if (nearSupportPct === null || rsiHot === null || vwapExtPct === null || days === null || days < 1 || typeof p.requireMacdBullish !== 'boolean' || typeof p.failOpen !== 'boolean') {
      return {
        key: ADAPTIVE_GATE_KEY, pass: false, skipped: false, detail: {},
        reason: 'gate params incomplete (need nearSupportPct, rsiHot, vwapExtPct, srLookbackDays, requireMacdBullish, failOpen)',
      };
    }
    const candles = await ctx.candles('15m', days);
    const r = adaptiveGate.evaluateDecisionGate(ctx.entryPrice, (candles ?? []).map(toGateCandle), ctx.now.getTime(), {
      nearSupportPct, rsiHot, vwapExtPct, requireMacdBullish: p.requireMacdBullish,
    });
    const detail = { ...r.detail, candles: candles === null ? null : candles.length, nearSupport: r.nearSupport, notExtended: r.notExtended, macdBullish: r.macdBullish };
    if (r.skipped && !p.failOpen) return { key: ADAPTIVE_GATE_KEY, pass: false, skipped: true, reason: `${r.reason}; failOpen is false`, detail };
    return { key: ADAPTIVE_GATE_KEY, pass: r.pass, skipped: r.skipped, reason: r.reason, detail };
  },
};

export const GATE_EVALUATORS: ReadonlyMap<string, GateEvaluator> = new Map([[ADAPTIVE_GATE_KEY, adaptiveStopGate]]);

/** Every gate must pass (spec §4.1); the first failure or unknown key stops the chain. */
export async function runGates(gates: readonly GateRef[], ctx: GateContext): Promise<{ pass: boolean; unknown: string | null; outcomes: GateOutcome[] }> {
  const outcomes: GateOutcome[] = [];
  for (const g of gates) {
    const evaluator = GATE_EVALUATORS.get(g.evaluatorKey);
    if (!evaluator) return { pass: false, unknown: g.evaluatorKey, outcomes };
    const o = await evaluator.evaluate(g.params, ctx);
    outcomes.push(o);
    if (!o.pass) return { pass: false, unknown: null, outcomes };
  }
  return { pass: true, unknown: null, outcomes };
}
