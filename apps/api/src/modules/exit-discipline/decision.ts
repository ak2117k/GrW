import type { ExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';
import { evaluatePersistence, type HistoryVerdict } from './persistence';
import { exposureOf } from './exposure';
import { scaledUnderlyingNoise } from './noise';
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
  // Only HARD_RISK skips confirmation. A thesis break by a "clear margin" used to bypass too, and on
  // 2026-10-21 three long puts were sold into the 09:15 spike that reversed minutes later.
  const p = evaluatePersistence({ current: i.current, history: i.history, bypass: g.hardRisk, cfg: i.cfg });
  // Opening guard: in the first minutes of the session only HARD_RISK may sell; a thesis break or a
  // floor breach must outlast the opening print.
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
  return `${head}${r.outcome === 'GATED_THESIS_INTACT' ? '' : '; '}${parts.join(', ')}`.slice(0, 300);
}

export function buildGateFacts(p: PacketFacts, ctx: {
  ltpNow: number; productType: string | null; minutesToClose: number | null; maxLossPerTrade: number | null;
  dailyLossLatched: boolean; history: HistoryVerdict[]; now: Date;
  nContractOverride?: number | null; nUnderlyingOverride?: number | null;
  /** Underlying exchange session length (minutes) for the daily-ATR fallback; default 375. */
  underlyingSessionMinutes?: number;
  floorOverride?: { price: number | null; armed: boolean; basis: FloorBasis };
}): GateFacts {
  const dir = p.side === 'LONG' ? 1 : -1;
  const fresh = Number.isFinite(ctx.ltpNow) && p.charges !== null ? (ctx.ltpNow - p.entryPrice) * p.qty * dir - p.charges : null;
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
    productType: ctx.productType,
    isExpiryDay: p.expiry !== null && p.expiry === istDate(ctx.now),
    dailyLossLatched: ctx.dailyLossLatched,
    minutesSinceOpen,
  };
}
