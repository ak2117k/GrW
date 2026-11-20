import type { ExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';
import { evaluatePersistence, type HistoryVerdict } from './persistence';
import { exposureOf } from './exposure';
import { scaledUnderlyingNoise } from './noise';
import type { PacketFacts } from './packet-facts';
import type { ChartGateRecord, ClauseId, FloorBasis, GateFactsSnapshot, GateRecordV1, ThesisSource } from './types';
import type { ChartConfirmMode } from './chart-read';

const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** `YYYY-MM-DD` in Asia/Kolkata. */
export function istDate(at: Date): string {
  return IST_DATE.format(at);
}

export function lastHoldRef(history: HistoryVerdict[]): GateFactsSnapshot['holdRef'] {
  const hold = [...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find((h) => h.verdict === 'HOLD');
  return hold
    ? { id: hold.id, underlying: hold.underlying, support: hold.support, resistance: hold.resistance, at: hold.createdAt.toISOString() }
    : null;
}

const cfgOf = (c: ExitDisciplineConfig): GateRecordV1['cfg'] => ({
  floorArmN: c.floorArmN, floorTrailN: c.floorTrailN, gateCloseMin: c.gateCloseMin,
  gateUnderlyingN: c.gateUnderlyingN, persistWindowSec: c.persistWindowSec, persistMinSec: c.persistMinSec,
});

export function bypassRecord(reason: 'DISABLED' | 'FACTS_UNREADABLE', cfg: ExitDisciplineConfig, now: Date, error?: string): GateRecordV1 {
  return {
    v: 1, outcome: 'BYPASS', bypassReason: reason, ...(error ? { error: error.slice(0, 300) } : {}),
    justification: null, clauses: [], persistence: null, facts: null, cfg: cfgOf(cfg), evaluatedAt: now.toISOString(),
  };
}

/**
 * Loss-side chart confirmation (chart-read.ts). Applies only when the exit's ONLY grounds are the loss-side code
 * rules — HARD_MAX_LOSS among the hard risks (never session close, expiry or the daily-loss latch) and/or
 * FLOOR_HARD_GREEN_TO_RED among the hard-floor clauses — with no thesis break, no confirmed floor breach, no
 * profit-side clause. Holds when the chart was read, is NOT against the position, and the loss is still above
 * −absLossRupees. Null when the mode is off or the exit is not loss-side.
 */
export function chartGateOf(
  g: ReturnType<typeof evaluateExitGate>,
  facts: GateFacts,
  opts: { mode: ChartConfirmMode; absLossRupees: number; profitMode?: ChartConfirmMode } | undefined,
): ChartGateRecord | null {
  if (!opts || !g.justified) return null;
  const passedClauses = g.clauses.filter((c) => c.pass === true);
  const passed = new Set(passedClauses.map((c) => c.id));
  const lossRules: ClauseId[] = ['HARD_MAX_LOSS', 'FLOOR_HARD_GREEN_TO_RED'];
  const lossSide = [...passed].length > 0 && [...passed].every((id) => lossRules.includes(id));
  const net = typeof facts.netPnlNow === 'number' && Number.isFinite(facts.netPnlNow) ? facts.netPnlNow : null;
  if (!lossSide) return profitChartGateOf(passedClauses, facts, net, opts);
  if (opts.mode === 'off') return null;
  const base = { mode: opts.mode, lossSide, side: 'loss' as const, netPnlNow: net, absLossRupees: opts.absLossRupees };
  const chart = facts.chart ?? null;
  let why: string;
  let wouldHold = false;
  if (net === null) why = 'net P&L unknown — exit stands';
  else if (net <= -opts.absLossRupees) why = `net ₹${Math.round(net)} at/below the absolute ₹${opts.absLossRupees} — exits whatever the chart says`;
  else if (!chart || !chart.known) why = 'chart not readable — exit stands';
  else if (chart.against) why = `chart against: ${chart.reasons.join('; ')}`;
  else {
    wouldHold = true;
    why = `chart intact (${chart.reasons.join('; ')}); net ₹${Math.round(net)} above −₹${opts.absLossRupees}`;
  }
  return { ...base, wouldHold, held: wouldHold && opts.mode === 'act', why: why.slice(0, 400) };
}

/**
 * Profit-side chart confirmation (PROFIT_CHART_CONFIRM, owner 2026-11-20). Applies only when the exit's ONLY grounds
 * are the profit-side code rules — FLOOR_HARD_GREEN_LOCK, FLOOR_HARD_UNDERLYING_MOVE and the TARGET_LADDER trail
 * (never the last target reached) — measured on the option premium and the 1-minute noise unit. Holds while the
 * trade is still net green (≥ ₹0: green-to-red stays a hard exit) and the chart was read and is NOT against.
 */
function profitChartGateOf(
  passedClauses: ReturnType<typeof evaluateExitGate>['clauses'],
  facts: GateFacts,
  net: number | null,
  opts: { absLossRupees: number; profitMode?: ChartConfirmMode },
): ChartGateRecord | null {
  const mode = opts.profitMode ?? 'off';
  if (mode === 'off' || passedClauses.length === 0) return null;
  const profitRules: ClauseId[] = ['FLOOR_HARD_GREEN_LOCK', 'FLOOR_HARD_UNDERLYING_MOVE', 'TARGET_LADDER'];
  if (!passedClauses.every((c) => profitRules.includes(c.id))) return null;
  const ladder = passedClauses.find((c) => c.id === 'TARGET_LADDER');
  if (ladder && (ladder.measured as { lastHit?: unknown } | undefined)?.lastHit === true) return null;
  const base = { mode, lossSide: false, side: 'profit' as const, netPnlNow: net, absLossRupees: opts.absLossRupees };
  const chart = facts.chart ?? null;
  let why: string;
  let wouldHold = false;
  if (net === null) why = 'net P&L unknown — exit stands';
  else if (net < 0) why = `net ₹${Math.round(net)} is red — green-to-red stays a hard exit`;
  else if (!chart || !chart.known) why = 'chart not readable — exit stands';
  else if (chart.against) why = `chart against: ${chart.reasons.join('; ')}`;
  else {
    wouldHold = true;
    why = `profit-side exit on premium noise with the chart intact (${chart.reasons.join('; ')}); net ₹${Math.round(net)} still green`;
  }
  return { ...base, wouldHold, held: wouldHold && mode === 'act', why: why.slice(0, 400) };
}

/** Spec §6 + §7 composed (R7). */
export function decideExit(i: {
  facts: GateFacts; current: { id: string; createdAt: Date }; history: HistoryVerdict[]; cfg: ExitDisciplineConfig; now: Date;
  chart?: { mode: ChartConfirmMode; absLossRupees: number; profitMode?: ChartConfirmMode };
}): GateRecordV1 {
  if (!i.cfg.enabled) return bypassRecord('DISABLED', i.cfg, i.now);
  const g = evaluateExitGate(i.facts, i.cfg);
  const cg = chartGateOf(g, i.facts, i.chart);
  const base = {
    v: 1 as const, justification: g.justification, clauses: g.clauses, facts: i.facts, cfg: cfgOf(i.cfg), evaluatedAt: i.now.toISOString(),
    ...(cg ? { chartGate: cg } : {}),
  };
  // The chart says the trade is intact and the loss is within the absolute cap: hold (act mode only).
  if (cg?.held) return { ...base, outcome: 'GATED_THESIS_INTACT', persistence: null };
  if (!g.justified) {
    // Fail OPEN when the gate cannot see: with no thesis or floor clause measurable
    // (no underlying LTP, no exposure, no invalidation/HOLD/VWAP), "thesis intact" is
    // not a finding, and blocking would hold every non-hard-risk AI exit — a
    // collapsing premium included — on a data gap. Same rule as unreadable facts
    // (Open Question 1); the clauses and facts stay on the record for the audit.
    if (g.clauses.filter((c) => !c.id.startsWith('HARD_')).every((c) => c.pass === null)) {
      return {
        ...base, outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE', persistence: null,
        error: 'no thesis or floor clause measurable (underlying, invalidation, HOLD level, VWAP)',
      };
    }
    return { ...base, outcome: 'GATED_THESIS_INTACT', persistence: null };
  }
  // Only HARD_RISK and the hard floor skip confirmation. A thesis break by a "clear margin" used to
  // bypass too, and on 2026-10-21 three long puts were sold into the 09:15 spike that reversed minutes
  // later. The hard floor is confirmed by its own two reads (the cycle's, and the packet's beside the
  // executor's fresh LTP) — waiting for a second EXIT_NOW would hand it back to a judge that may HOLD.
  const p = evaluatePersistence({ current: i.current, history: i.history, bypass: g.hardRisk || g.floorHard || g.ladder, cfg: i.cfg });
  // Opening guard: in the first minutes of the session only HARD_RISK may sell; a thesis break or a
  // floor breach — the hard floor included — must outlast the opening print.
  const since = i.facts.minutesSinceOpen;
  if (!g.hardRisk && typeof since === 'number' && Number.isFinite(since) && since >= 0 && since < i.cfg.openingGuardMin) {
    return {
      ...base, outcome: 'AWAITING_CONFIRMATION', persistence: { ...p, confirmed: false, rule: null },
      openingGuard: { minutesSinceOpen: Math.round(since * 10) / 10, guardMin: i.cfg.openingGuardMin },
    };
  }
  return { ...base, outcome: p.confirmed ? 'PASS' : 'AWAITING_CONFIRMATION', persistence: p };
}


export function isBlocking(r: GateRecordV1 | null | undefined): boolean {
  return r?.outcome === 'GATED_THESIS_INTACT' || r?.outcome === 'AWAITING_CONFIRMATION';
}

/** One log/UI line: outcome + the numbers that decided it. */
/** Display only: a noise unit to 2 dp ('?' when unknown). Stored facts keep full precision. */
const dp2 = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '?' : String(Math.round(n * 100) / 100);

export function gateSummary(r: GateRecordV1): string {
  if (r.outcome === 'BYPASS') return `BYPASS: ${r.bypassReason}${r.error ? ` (${r.error})` : ''}`.slice(0, 300);
  const f = r.facts;
  const parts: string[] = [];
  if (f) {
    parts.push(`u ${f.underlying ?? '?'}`, `inv ${f.invalidation ?? '?'}`);
    if (f.holdRef) parts.push(`held ${f.exposure === 'BEARISH' ? f.holdRef.resistance : f.holdRef.support} @HOLD u ${f.holdRef.underlying ?? '?'}`);
    parts.push(`vwap ${f.vwap ?? '?'}`, `floor ${f.floor.price ?? '?'}${f.floor.armed ? '' : ' (unarmed)'} ltp ${f.ltpNow}`,
      `N ${dp2(f.nContract)}/${dp2(f.nUnderlying)}`);
  }
  const passed = r.clauses.filter((c) => c.pass === true).map((c) => c.id);
  const head = r.outcome === 'PASS' || r.outcome === 'AWAITING_CONFIRMATION'
    ? `${r.outcome}: ${r.justification} via ${passed.join('+')}${r.persistence ? ` persist=${r.persistence.rule ?? 'pending'}` : ''}`
    : `${r.outcome}: `;
  const chart = r.chartGate
    ? `${r.chartGate.held ? 'CHART HOLD' : r.chartGate.wouldHold ? 'chart would hold (observe)' : 'chart'}: ${r.chartGate.why}; `
    : '';
  return `${head}${r.outcome === 'GATED_THESIS_INTACT' ? '' : '; '}${chart}${parts.join(', ')}`.slice(0, 400);
}

export function buildGateFacts(p: PacketFacts, ctx: {
  ltpNow: number; productType: string | null; minutesToClose: number | null; maxLossPerTrade: number | null;
  dailyLossLatched: boolean; history: HistoryVerdict[]; now: Date;
  nContractOverride?: number | null; nUnderlyingOverride?: number | null;
  /** Underlying exchange session length (minutes) for the daily-ATR fallback; default 375. */
  underlyingSessionMinutes?: number;
  floorOverride?: { price: number | null; armed: boolean; basis: FloorBasis };
  /** MCX rupees per unit of qty per point (contractValueFactor in @td/shared); absent ⇒ 1. */
  valueFactor?: number;
  /** The packet thesis's source (thesisSourceOf); absent ⇒ the facts carry no thesisSource, as before. */
  thesisSource?: ThesisSource | null;
  /** The broker's MIS square-off lead for this exchange (GateFacts.squareOffLeadMin); absent ⇒ not set. */
  squareOffLeadMin?: number | null;
}): GateFacts {
  const dir = p.side === 'LONG' ? 1 : -1;
  const vf = typeof ctx.valueFactor === 'number' && Number.isFinite(ctx.valueFactor) && ctx.valueFactor > 0 ? ctx.valueFactor : 1;
  const fresh = Number.isFinite(ctx.ltpNow) && p.charges !== null ? (ctx.ltpNow - p.entryPrice) * p.qty * vf * dir - p.charges : null;
  const netPnlNow = p.netPnl === null ? fresh : fresh === null ? p.netPnl : Math.min(p.netPnl, fresh);
  const scaled = scaledUnderlyingNoise(p.levelBookAtr15m, '', ctx.underlyingSessionMinutes)?.n ?? null;
  const mtc = ctx.minutesToClose ?? p.minutesToClose;
  const minutesSinceOpen = ctx.underlyingSessionMinutes !== undefined && typeof mtc === 'number' && Number.isFinite(mtc)
    ? ctx.underlyingSessionMinutes - mtc : null;
  return {
    exposure: p.symbol ? exposureOf(p.symbol, p.side) : null,
    positionSide: p.side,
    ltpNow: ctx.ltpNow,
    underlying: p.underlying,
    invalidation: p.invalidation,
    holdRef: lastHoldRef(ctx.history),
    vwap: p.vwap,
    nContract: ctx.nContractOverride !== undefined ? ctx.nContractOverride : p.noise?.contract?.n ?? null,
    nUnderlying: ctx.nUnderlyingOverride !== undefined ? ctx.nUnderlyingOverride : p.noise?.underlying?.n ?? scaled,
    floor: ctx.floorOverride ?? p.floor,
    netPnlNow,
    maxLossPerTrade: ctx.maxLossPerTrade,
    minutesToClose: ctx.minutesToClose ?? p.minutesToClose,
    ...(ctx.squareOffLeadMin !== undefined ? { squareOffLeadMin: ctx.squareOffLeadMin } : {}),
    productType: ctx.productType,
    isExpiryDay: p.expiry !== null && p.expiry === istDate(ctx.now),
    dailyLossLatched: ctx.dailyLossLatched,
    minutesSinceOpen,
    // FLOOR_HARD_EXIT: only for a packet that carries money.anchors — older packets keep the legacy facts.
    ...(p.anchors
      ? { anchors: { bestUnderlying: p.anchors.bestUnderlying, armUnderlying: p.anchors.armUnderlying, packetLtp: p.ltp, packetNetPnl: p.netPnl, freshNetPnl: fresh } }
      : {}),
    // TARGET_LADDER: only for a packet whose money.ladder is enforced — every other packet reads as before.
    ...(p.ladder?.enforced
      ? { ladder: { stop: p.ladder.stop, stage: p.ladder.stage, lastHit: p.ladder.lastHit, packetLtp: p.ltp } }
      : {}),
    // Thesis source (2026-11-04, spec D8/D10): only when the caller read one, so other callers' facts are unchanged.
    ...(ctx.thesisSource !== undefined ? { thesisSource: ctx.thesisSource } : {}),
  };
}

/**
 * The stored packet's `thesis.value.source` (the packet copies the thesis row's source verbatim), or null
 * when the thesis block is absent or carries no known source. Defensive: the packet is JSON from the DB.
 */
export function thesisSourceOf(packet: unknown): ThesisSource | null {
  const o = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
  const block = o(o(packet)?.thesis);
  const src = block && block.available === true ? o(block.value)?.source : null;
  return src === 'INFERRED' || src === 'USER' ? src : null;
}
