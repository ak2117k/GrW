import type { ExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';
import { evaluatePersistence, type HistoryVerdict } from './persistence';
import { exposureOf } from './exposure';
import type { PacketFacts } from './packet-facts';
import type { FloorBasis, GateFactsSnapshot, GateRecordV1 } from './types';

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

/** Spec §6 + §7 composed (R7). */
export function decideExit(i: {
  facts: GateFacts; current: { id: string; createdAt: Date }; history: HistoryVerdict[]; cfg: ExitDisciplineConfig; now: Date;
}): GateRecordV1 {
  if (!i.cfg.enabled) return bypassRecord('DISABLED', i.cfg, i.now);
  const g = evaluateExitGate(i.facts, i.cfg);
  const base = { v: 1 as const, justification: g.justification, clauses: g.clauses, facts: i.facts, cfg: cfgOf(i.cfg), evaluatedAt: i.now.toISOString() };
  if (!g.justified) return { ...base, outcome: 'GATED_THESIS_INTACT', persistence: null };
  const p = evaluatePersistence({ current: i.current, history: i.history, bypass: g.hardRisk || g.thesisClearMargin, cfg: i.cfg });
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
  return `${head}${r.outcome === 'GATED_THESIS_INTACT' ? '' : '; '}${parts.join(', ')}`.slice(0, 300);
}

export function buildGateFacts(p: PacketFacts, ctx: {
  ltpNow: number; productType: string | null; minutesToClose: number | null; maxLossPerTrade: number | null;
  dailyLossLatched: boolean; history: HistoryVerdict[]; now: Date;
  nContractOverride?: number | null; nUnderlyingOverride?: number | null;
  floorOverride?: { price: number | null; armed: boolean; basis: FloorBasis };
}): GateFacts {
  const dir = p.side === 'LONG' ? 1 : -1;
  const fresh = Number.isFinite(ctx.ltpNow) && p.charges !== null ? (ctx.ltpNow - p.entryPrice) * p.qty * dir - p.charges : null;
  const netPnlNow = p.netPnl === null ? fresh : fresh === null ? p.netPnl : Math.min(p.netPnl, fresh);
  const scaled = p.levelBookAtr15m !== null && p.levelBookAtr15m > 0 ? p.levelBookAtr15m / Math.sqrt(15) : null;
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
    productType: ctx.productType,
    isExpiryDay: p.expiry !== null && p.expiry === istDate(ctx.now),
    dailyLossLatched: ctx.dailyLossLatched,
  };
}
