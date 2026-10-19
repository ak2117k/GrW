import * as adaptiveGate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import { mbmHorizonFor, usableHorizon } from '../../mbm/domain/mbm-applies';
import type { MbmMode } from '../../mbm/mbm.config';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';
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
  /** MBM M3 inputs for the `market-behaviour` gate; absent ⇒ that gate passes with applies:false. */
  mbm?: MbmGateAccess;
}

export interface MbmGateAccess {
  /** Effective MBM_ENTRY_GATE (mbmEntryGateMode: off whenever MBM_ENABLED=off). */
  mode: MbmMode;
  /** mbmInstrumentFor(the entry), or null for a non-MBM (non-NIFTY) entry. */
  instrument: string | null;
  /** MbmClient.behaviour, fetched at most once per intake attempt. */
  behaviour(instrument: string): Promise<MbmBehaviour>;
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

/**
 * MBM M3 entry gate (plan 2026-10-19-mbm-m3-consumers, stream B). Params from the strategy version,
 * scalars only: `skipRegimes` (comma-separated, e.g. "QUIET"; default none) and `horizon`
 * (auto|30m|60m; default auto = by session minutes left). MBM_ENTRY_GATE=observe ⇒ always passes and
 * records `wouldSkip`; on ⇒ a skipped regime fails the gate. Non-NIFTY entries, a gate that is off and
 * absent/stale answers always pass with `applies:false` — a missing MBM value never blocks an entry.
 */
export const MBM_GATE_KEY = 'market-behaviour';

const MBM_HORIZONS = ['auto', '30m', '60m'];
/** NSE/NFO close, IST minutes (15:30). The only instrument MBM v1 maps is NIFTY. */
const NSE_CLOSE_IST_MIN = 15 * 60 + 30;
const istMinutes = (d: Date): number => (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;

const marketBehaviourGate: GateEvaluator = {
  async evaluate(p, ctx) {
    const m = ctx.mbm;
    const mode: MbmMode = m?.mode ?? 'off';
    const passes = (reason: string, extra: Record<string, unknown> = {}): GateOutcome => ({
      key: MBM_GATE_KEY, pass: true, skipped: true, reason, detail: { mode, applies: false, ...extra },
    });
    if (!m || mode === 'off') return passes('MBM entry gate is off');

    const skipRaw = p.skipRegimes ?? '';
    const horizonRaw = p.horizon ?? 'auto';
    if (typeof skipRaw !== 'string' || typeof horizonRaw !== 'string' || !MBM_HORIZONS.includes(horizonRaw)) {
      const reason = 'gate params invalid (skipRegimes: comma-separated regimes; horizon: auto|30m|60m)';
      if (mode === 'on') return { key: MBM_GATE_KEY, pass: false, skipped: false, reason, detail: { mode, applies: false } };
      return passes(reason);
    }
    if (!m.instrument) return passes('not an MBM instrument');

    const skipRegimes = skipRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const horizon = horizonRaw === 'auto' ? mbmHorizonFor(NSE_CLOSE_IST_MIN - istMinutes(ctx.now)) : horizonRaw;
    let b: MbmBehaviour | null = null;
    try {
      b = await m.behaviour(m.instrument);
    } catch {
      b = null; // MbmClient never throws; a stub that does is still only "absent".
    }
    const h = usableHorizon(b, horizon);
    if (!h) return passes(`no usable MBM answer (${b?.status ?? 'absent'})`, { instrument: m.instrument, horizon, status: b?.status ?? 'absent' });

    const regime = String(h.regime).toUpperCase();
    const wouldSkip = skipRegimes.includes(regime);
    const detail = {
      mode, applies: true, instrument: m.instrument, horizon, regime: h.regime, p: h.p,
      rangeBp: [h.q25Bp, h.q75Bp], q50Bp: h.q50Bp, asOf: b?.asOf ?? null,
      modelId: b?.modelIds?.[horizon] ?? null, featureSet: b?.featureSet ?? null, wouldSkip,
    };
    const what = `MBM ${m.instrument} ${horizon} regime ${h.regime} (p=${h.p})`;
    if (!wouldSkip) return { key: MBM_GATE_KEY, pass: true, skipped: false, reason: `${what} is not skipped`, detail };
    if (mode === 'on') return { key: MBM_GATE_KEY, pass: false, skipped: false, reason: `${what} is in skipRegimes`, detail };
    return { key: MBM_GATE_KEY, pass: true, skipped: false, reason: `observe: would skip — ${what} is in skipRegimes`, detail };
  },
};

export const GATE_EVALUATORS: ReadonlyMap<string, GateEvaluator> = new Map([
  [ADAPTIVE_GATE_KEY, adaptiveStopGate],
  [MBM_GATE_KEY, marketBehaviourGate],
]);

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
