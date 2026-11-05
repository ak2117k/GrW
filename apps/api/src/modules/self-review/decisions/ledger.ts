/**
 * The decision ledger as a VIEW over the tables that already record decisions (spec goal 1; plan F2).
 * Pure: pre-read source rows (+ a bar lookup) in, `decision_grades` drafts out. The repository decides
 * which rows belong to the window; these decide what each row's decision was and how it is graded.
 *
 * Reuse before recompute (spec goal 2): ai_exit_outcomes' closeAt15/30/60 for exits, signal_decisions'
 * stored fair check for entries (only where the value factor is 1 — see grade.takeOutcome), and the carry
 * scorer's priceAt1015 for carries. Everything else is graded on candles_1m bars.
 */
import { contractValueFactor } from '@td/shared';
import { aiDecisionOf } from '../../signal-trader/domain/ai-check';
import type { FairCheck } from '../../signal-trader/domain/fair-score';
import { judgeFacts } from '../../signal-trader/domain/fair-inputs';
import { MANUAL_VERDICT_PREFIX } from '../../sentinel-executor/domain/manual-exit';
import { segmentFor } from '../../trade-sentinel/charges';
import { EXIT_HORIZONS, gradeCarry, gradeExit, gradeGated, gradeSkip, gradeTake, HORIZON_MS, isWrong, takeOutcome, takeOutcomeFromFair, type TakeOutcome } from './grade';
import type { Bar, DecisionGradeDraft, DecisionType, Grade, GradeMode, Horizon } from './types';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const MIN = 60_000;
const IST = 330 * MIN;

export const istYmd = (ms: number): string => new Date(ms + IST).toISOString().slice(0, 10);
/** UTC ms of IST midnight on `ymd`. */
export const istMidnight = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`) - IST;

/** When an untouched entry is closed: 15:30 IST (NSE / NFO / BFO / BSE), 23:30 IST on MCX. */
export function sessionEndTs(ymd: string, exchange: string | null | undefined): number {
  const mcx = String(exchange ?? '').toUpperCase().startsWith('MCX');
  return istMidnight(ymd) + (mcx ? 23 * 60 + 30 : 15 * 60 + 30) * MIN;
}

/** Bars of one contract (exchange, token) for the window, or null when nothing is stored. */
export type BarLookup = (exchange: string | null | undefined, token: string | null | undefined) => Bar[] | null;

const segOf = (exchange: string | null | undefined, symbol: string | null | undefined) => segmentFor({ exchange: String(exchange ?? ''), symbol: String(symbol ?? ''), kind: 'POSITION' });

function draft(base: Omit<DecisionGradeDraft, 'horizon' | 'pnlChosen' | 'pnlAlternative' | 'deltaRupees' | 'verdict' | 'reason'>, g: Grade): DecisionGradeDraft {
  return { ...base, horizon: g.horizon, pnlChosen: g.pnlChosen, pnlAlternative: g.pnlAlternative, deltaRupees: g.deltaRupees, verdict: g.verdict, reason: g.reason.slice(0, 300) };
}

/** A horizon is graded only once it is over (a later run fills it in; the upsert is idempotent). */
export function horizonOver(h: Horizon, decidedAt: number, now: number, endTs?: number): boolean {
  if (h === '15m' || h === '30m' || h === '60m') return decidedAt + HORIZON_MS[h] + 5 * MIN <= now;
  return endTs === undefined || endTs <= now;
}

// ─── Entries: signal_decisions ───────────────────────────────────────────────

export interface SignalDecisionSrc {
  id: string;
  userId: string | null;
  underlying: string | null;
  decidedAt: Date;
  /** shadow | live */
  mode: string;
  decision: string | null;
  skipReason: string | null;
  gate: unknown;
  judge: unknown;
  plan: unknown;
  aiCheck: unknown;
}

export type EntryKind = { type: 'ENTRY_TAKE' | 'ENTRY_SKIP' | 'ENTRY_BLOCKED'; blocker: string | null };

/** The first required gate check that failed, or null. */
export function failedGate(gate: unknown): string | null {
  if (!Array.isArray(gate)) return null;
  const f = gate.map(obj).find((c) => c.required !== false && c.ok === false);
  return f ? str(f.name) ?? 'gate' : null;
}

/**
 * What the system chose on a call: BLOCKED when a gate refused it (the live gate's liveGateBlocked —
 * the call was then learning-paper-traded — or a failed required check on a SKIP), else the judge's own
 * call (TAKE / SKIP), else the stored decision.
 */
export function entryKindOf(sd: Pick<SignalDecisionSrc, 'decision' | 'gate' | 'judge'>): EntryKind {
  const j = obj(sd.judge);
  const lg = j.liveGateBlocked;
  if (lg !== undefined && lg !== null && lg !== false) return { type: 'ENTRY_BLOCKED', blocker: str(lg) ?? 'gate' };
  if (sd.decision === 'SKIP') {
    const g = failedGate(sd.gate);
    if (g) return { type: 'ENTRY_BLOCKED', blocker: g };
  }
  const ai = aiDecisionOf(j);
  if (ai === 'TAKE') return { type: 'ENTRY_TAKE', blocker: null };
  if (ai === 'SKIP') return { type: 'ENTRY_SKIP', blocker: null };
  return sd.decision === 'TAKE' ? { type: 'ENTRY_TAKE', blocker: null } : { type: 'ENTRY_SKIP', blocker: null };
}

/** Entry (take / skip / blocked) and SIZE drafts for one signal decision. */
export function entryDrafts(sd: SignalDecisionSrc, bars: BarLookup, now: number): DecisionGradeDraft[] {
  const plan = obj(sd.plan);
  const exchange = str(plan.exchange);
  const symbol = str(plan.tradingsymbol);
  const kind = entryKindOf(sd);
  const decidedAt = sd.decidedAt.getTime();
  const sessionDate = istYmd(decidedAt);
  const endTs = sessionEndTs(sessionDate, exchange);
  const live = sd.mode === 'live' && sd.decision === 'TAKE';
  const mode: GradeMode = live ? 'live' : 'paper';
  const vf = contractValueFactor(exchange, symbol);
  const segment = segOf(exchange, symbol);
  const f = judgeFacts(sd.judge, sd.plan, 1);
  const entry = num(plan.limitPrice) ?? num(plan.ltp);
  const side = String(plan.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const taken = kind.type === 'ENTRY_TAKE';
  const base = {
    sessionDate, decisionType: kind.type as DecisionType, detector: null, refTable: 'signal_decisions', refId: sd.id, userId: sd.userId,
    symbol, underlying: sd.underlying, mode, decidedAt: sd.decidedAt,
    chosen: taken ? 'take' : kind.type === 'ENTRY_BLOCKED' ? `blocked: ${kind.blocker}` : 'skip',
    alternative: taken ? 'skip' : 'take',
  };
  const out: DecisionGradeDraft[] = [];

  if (horizonOver('close', decidedAt, now, endTs)) {
    let t: TakeOutcome;
    let method: string;
    const fair = obj(obj(sd.aiCheck).fair) as Partial<FairCheck>;
    const storedOk = vf === 1 && typeof fair.verdict === 'string' && fair.capOutcome && fair.capOutcome.result !== 'UNSCORABLE' && entry !== null;
    if (!plan.tradingsymbol) {
      t = { pnl: null, outcome: null, reason: 'no plan (the contract was never resolved)' };
      method = 'none';
    } else if (storedOk) {
      t = takeOutcomeFromFair(fair as FairCheck, { side, entry: entry as number, lotQty: f.lotQty, valueFactor: vf, segment });
      method = 'fair-stored';
    } else {
      t = takeOutcome({
        side, entry: entry ?? 0, entryTs: decidedAt, sl: f.signalSl, targets: f.targets, lotQty: f.lotQty, valueFactor: vf, segment,
        cap: f.cap, tick: f.tick, path: bars(exchange, str(plan.token)), endTs,
      });
      method = 'contract-1m';
    }
    const g = taken ? gradeTake({ outcome: t }) : gradeSkip({ outcome: t });
    out.push(
      draft(
        {
          ...base,
          facts: {
            method, entry, side, sl: f.signalSl, targets: f.targets, lotQty: f.lotQty, valueFactor: vf, cap: f.cap, capSource: f.capSource,
            outcome: t.outcome ? { result: t.outcome.result, stop: t.outcome.stop, price: t.outcome.price, at: t.outcome.at } : null,
            judge: f.aiDecision, confidence: num(obj(sd.judge).confidence), reasons: f.reasons.slice(0, 3).map((r) => r.slice(0, 200)),
            decision: sd.decision, skipReason: sd.skipReason, blocker: kind.blocker, signalMode: sd.mode,
          },
        },
        g,
      ),
    );
  }

  const size = sizeGrade(plan, vf);
  if (size) out.push({ ...base, decisionType: 'SIZE', chosen: `risk ₹${size.recorded}`, alternative: `risk ₹${size.real} at real contract value`, horizon: 'close', ...size.grade, facts: { valueFactor: vf, lots: num(plan.lots), qty: num(plan.qty), lotSize: num(plan.lotSize), limitPrice: entry, sl: num(plan.sl), recorded: size.recorded, real: size.real } });
  return out;
}

/**
 * SIZE: the plan's recorded 1-trade risk vs |limit − SL| × qty × contract value (spec item 3: GOLD sizing
 * was 100× off). WRONG when they differ by ≥ ₹500. No stop (learning plan, sl 0) ⇒ nothing to check.
 * The delta is the absolute misstatement, not a P&L.
 */
export function sizeGrade(plan: Rec, vf: number): { recorded: number; real: number; grade: Pick<Grade, 'pnlChosen' | 'pnlAlternative' | 'deltaRupees' | 'verdict' | 'reason'> } | null {
  const limit = num(plan.limitPrice);
  const sl = num(plan.sl);
  const qty = num(plan.qty);
  const recorded = num(plan.riskRupees);
  if (limit === null || sl === null || !(sl > 0) || qty === null || !(qty > 0) || recorded === null || plan.slSource === 'none') return null;
  const real = r2(Math.abs(limit - sl) * qty * (vf > 0 ? vf : 1));
  const diff = r2(Math.abs(real - recorded));
  const wrong = isWrong(diff, null);
  return {
    recorded, real,
    grade: { pnlChosen: null, pnlAlternative: null, deltaRupees: diff, verdict: wrong ? 'WRONG' : 'RIGHT', reason: `planned risk ₹${recorded} vs ₹${real} at |${limit} − ${sl}| × ${qty} × ${vf}${wrong ? ' — the sizing used the wrong contract value' : ''}` },
  };
}

// ─── Exits: ai_exit_executions (+ ai_exit_outcomes) ──────────────────────────

export interface ExitOutcomeSrc {
  kind: string;
  status: string;
  positionSide: string;
  qty: number;
  decisionPrice: number;
  decisionAt: Date;
  closeAt15: number | null;
  closeAt30: number | null;
  closeAt60: number | null;
}

export interface ExitExecSrc {
  id: string;
  userId: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  token: string | null;
  /** The exit ORDER's side (SELL closes a LONG). */
  side: string | null;
  quantity: number | null;
  mode: string;
  status: string;
  reason: string | null;
  verdictReason: string;
  gate: unknown;
  decisionLtp: number | null;
  decisionAt: Date | null;
  fillPrice: number | null;
  createdAt: Date;
  outcome: ExitOutcomeSrc | null;
  /** The exit verdict's packet had a latched money.spike (SPIKE BANK trail). */
  spikeLatched: boolean;
  /** The tracker's eventual exit (gated rows are judged against it). */
  trackerExitPrice: number | null;
  lotQty: number | null;
  underlying: string | null;
}

const EXECUTED = new Set(['PLACED', 'FILLED', 'DRY_RUN']);
const GATED = new Set(['GATED_THESIS_INTACT', 'AWAITING_CONFIRMATION']);

/** Which ledger type an executed AI exit is, from the gate's justification (E7) and the spike latch. */
export function exitTypeOf(gate: unknown, spikeLatched: boolean): DecisionType {
  const g = obj(gate);
  const j = str(g.justification);
  if (j === 'TARGET_LADDER') return 'LADDER';
  if (j === 'CONFIRMED_FLOOR_BREACH' || j === 'FLOOR_HARD_EXIT') return spikeLatched ? 'SPIKE_BANK' : 'FLOOR';
  if (j === 'HARD_RISK') {
    const clauses = Array.isArray(g.clauses) ? g.clauses.map(obj) : [];
    if (clauses.some((c) => (c.id === 'HARD_MAX_LOSS' || c.id === 'HARD_DAILY_LOSS') && c.pass === true)) return 'HARD_LOSS';
  }
  return 'EXIT';
}

/** The exit-family drafts (EXIT / FLOOR / SPIKE_BANK / HARD_LOSS / LADDER / GATED_EXIT) for one execution row. */
export function exitDrafts(e: ExitExecSrc, bars: BarLookup, now: number): DecisionGradeDraft[] {
  // Manual exits are the owner's decisions, not the system's.
  if (e.verdictId.startsWith(MANUAL_VERDICT_PREFIX)) return [];
  const g = obj(e.gate);
  const outcome = str(g.outcome);
  const gated = e.status === 'SKIPPED' && outcome !== null && GATED.has(outcome);
  if (!gated && !EXECUTED.has(e.status)) return [];
  const price = e.outcome?.decisionPrice ?? e.fillPrice ?? e.decisionLtp;
  const at = (e.outcome?.decisionAt ?? e.decisionAt ?? e.createdAt).getTime();
  const side: 'LONG' | 'SHORT' = e.outcome ? (e.outcome.positionSide === 'SHORT' ? 'SHORT' : 'LONG') : String(e.side ?? 'SELL').toUpperCase() === 'BUY' ? 'SHORT' : 'LONG';
  const vf = contractValueFactor(e.exchange, e.symbol);
  const segment = segOf(e.exchange, e.symbol);
  const facts = obj(g.facts);
  const noiseUnit = num(facts.nContract);
  const perLot = e.lotQty !== null && e.lotQty > 0;
  const lotQty = perLot ? (e.lotQty as number) : Math.abs(e.outcome?.qty ?? e.quantity ?? 0);
  const type: DecisionType = gated ? 'GATED_EXIT' : exitTypeOf(e.gate, e.spikeLatched);
  const mode: GradeMode = e.trackerId.startsWith('paper:') || e.mode !== 'live' ? 'paper' : 'live';
  const closes = e.outcome && e.outcome.status === 'DONE' ? { '15m': e.outcome.closeAt15, '30m': e.outcome.closeAt30, '60m': e.outcome.closeAt60 } : undefined;
  const base = {
    sessionDate: istYmd(at), decisionType: type, detector: null, refTable: 'ai_exit_executions', refId: e.id, userId: e.userId,
    symbol: e.symbol, underlying: e.underlying, mode, decidedAt: new Date(at),
    chosen: gated ? `hold (gate ${outcome})` : `exit (${type.toLowerCase()})`, alternative: gated ? 'exit' : 'hold',
    facts: {
      status: e.status, gateOutcome: outcome, justification: str(g.justification), price, side, lotQty, perLot, valueFactor: vf, noiseUnit,
      source: closes ? 'ai_exit_outcomes' : 'candles_1m', verdictId: e.verdictId, trackerId: e.trackerId, verdictReason: e.verdictReason.slice(0, 300),
      eventualExit: e.trackerExitPrice,
    },
  };
  const horizons = EXIT_HORIZONS.filter((h) => horizonOver(h, at, now));
  const grades = horizons.length
    ? gradeExit({ side, exitPrice: price ?? 0, decidedAt: at, qty: e.outcome?.qty ?? e.quantity ?? undefined, lotQty, valueFactor: vf, segment, path: closes ? null : bars(e.exchange, e.token), closes, noiseUnit, chosen: gated ? 'hold' : 'exit', horizons })
    : [];
  const out = grades.map((gr) => draft(base, gr));
  if (gated) out.push(draft(base, gradeGated({ side, gatedPrice: price ?? 0, eventualExit: e.trackerExitPrice, lotQty, valueFactor: vf, segment, noiseUnit })));
  return out;
}

// ─── HOLD verdicts: sentinel_verdicts ────────────────────────────────────────

export interface HoldVerdictSrc {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  createdAt: Date;
}

export interface TrackerSrc {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  qty: number;
  lotQty: number | null;
  underlying: string | null;
}

/** HOLD verdicts are dense (every cycle): one per tracker per 30-min bucket — the first — is graded. */
export function sampleHolds<T extends Pick<HoldVerdictSrc, 'trackerId' | 'createdAt'>>(rows: readonly T[], bucketMin = 30): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const k = `${r.trackerId}|${Math.floor(r.createdAt.getTime() / (bucketMin * MIN))}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** The close of the last bar that ENDED by `ts` (within 5 min), or null — no look-ahead into the decision minute. */
export function priceBefore(path: readonly Bar[] | null, ts: number): number | null {
  if (!path) return null;
  let best: Bar | null = null;
  for (const b of path) if (b.ts + MIN <= ts && (!best || b.ts > best.ts)) best = b;
  return best && ts - (best.ts + MIN) <= 5 * MIN && best.close > 0 ? best.close : null;
}

/** HOLD vs exiting at that moment, at +30 min. */
export function holdDrafts(v: HoldVerdictSrc, t: TrackerSrc | undefined, bars: BarLookup, now: number): DecisionGradeDraft[] {
  const at = v.createdAt.getTime();
  if (!t || !horizonOver('30m', at, now)) return [];
  const path = bars(t.exchange, t.token);
  const p0 = priceBefore(path, at);
  const vf = contractValueFactor(t.exchange, t.symbol);
  const perLot = t.lotQty !== null && t.lotQty > 0;
  const lotQty = perLot ? (t.lotQty as number) : Math.abs(t.qty);
  const side: 'LONG' | 'SHORT' = t.qty < 0 ? 'SHORT' : 'LONG';
  const base = {
    sessionDate: istYmd(at), decisionType: 'HOLD' as const, detector: null, refTable: 'sentinel_verdicts', refId: v.id, userId: v.userId,
    symbol: t.symbol, underlying: t.underlying, mode: 'live' as const, decidedAt: v.createdAt, chosen: 'hold', alternative: 'exit',
    facts: { trackerId: t.id, price: p0, side, lotQty, perLot, valueFactor: vf },
  };
  const [g] = gradeExit({ side, exitPrice: p0 ?? 0, decidedAt: at, lotQty, valueFactor: vf, segment: segOf(t.exchange, t.symbol), path, chosen: 'hold', horizons: ['30m'] });
  return [draft(base, p0 === null ? { ...g, reason: 'missing bars: no contract price at the verdict' } : g)];
}

// ─── Paper exits: trades ─────────────────────────────────────────────────────

export interface PaperExitSrc {
  id: string;
  userId: string;
  side: string;
  quantity: number;
  exitPrice: number | null;
  exitTime: Date;
  exitReasonTag: string | null;
  strategy: string | null;
  symbol: string;
  exchange: string;
  token: string;
  lotSize: number | null;
  underlying: string | null;
}

/** A session-close square-off is the clock, not a decision. */
const NOT_A_DECISION = /^(TIME_EXIT|EOD|SQUARE_?OFF|SESSION_END|EXPIRY)/i;

export function paperExitTypeOf(tag: string | null): DecisionType | null {
  const t = String(tag ?? '').toUpperCase();
  if (NOT_A_DECISION.test(t)) return null;
  if (t === 'HIT_TARGET' || t === 'MOVED_STOP' || t === 'TRAIL') return 'LADDER';
  return 'EXIT';
}

export function paperExitDrafts(p: PaperExitSrc, bars: BarLookup, now: number): DecisionGradeDraft[] {
  const type = paperExitTypeOf(p.exitReasonTag);
  if (!type) return [];
  const at = p.exitTime.getTime();
  const horizons = EXIT_HORIZONS.filter((h) => horizonOver(h, at, now));
  if (horizons.length === 0) return [];
  const vf = contractValueFactor(p.exchange, p.symbol);
  const perLot = p.lotSize !== null && p.lotSize > 0;
  const lotQty = perLot ? (p.lotSize as number) : Math.abs(p.quantity);
  const side: 'LONG' | 'SHORT' = String(p.side).toUpperCase() === 'SELL' ? 'SHORT' : 'LONG';
  const base = {
    sessionDate: istYmd(at), decisionType: type, detector: null, refTable: 'trades', refId: p.id, userId: p.userId,
    symbol: p.symbol, underlying: p.underlying, mode: 'paper' as const, decidedAt: p.exitTime, chosen: `exit (${p.exitReasonTag ?? 'untagged'})`, alternative: 'hold',
    facts: { price: p.exitPrice, side, lotQty, perLot, valueFactor: vf, exitReasonTag: p.exitReasonTag, strategy: p.strategy },
  };
  return gradeExit({ side, exitPrice: p.exitPrice ?? 0, decidedAt: at, lotQty, valueFactor: vf, segment: segOf(p.exchange, p.symbol), path: bars(p.exchange, p.token), horizons }).map((g) => draft(base, g));
}

// ─── Carries: intraday_carry_decisions ───────────────────────────────────────

export interface CarrySrc {
  id: string;
  userId: string;
  mode: string;
  istDay: string;
  symbol: string;
  exchange: string;
  positionSide: string;
  qty: number;
  decision: string;
  reason: string;
  decisionPrice: number | null;
  decidedAt: Date;
  scoreStatus: string;
  priceAt1015: number | null;
  pnlCarry: number | null;
  lotQty: number | null;
  underlying: string | null;
}

export function carryDrafts(c: CarrySrc): DecisionGradeDraft[] {
  if (c.scoreStatus !== 'DONE') return [];
  // A cap-blocked carry was squared off by the broker: scored as the EXIT it became (carry-score does the same).
  const decision: 'CARRY' | 'EXIT' | null = c.decision === 'CARRY' ? 'CARRY' : c.decision === 'EXIT' || c.decision === 'CAP_BLOCKED_BROKER_SQUARE_OFF' ? 'EXIT' : null;
  if (!decision) return [];
  const vf = contractValueFactor(c.exchange, c.symbol);
  const perLot = c.lotQty !== null && c.lotQty > 0;
  const lotQty = perLot ? (c.lotQty as number) : Math.abs(c.qty);
  const side: 'LONG' | 'SHORT' = c.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
  const g = gradeCarry({ decision, side, decisionPrice: c.decisionPrice, priceAt1015: c.priceAt1015, lotQty, valueFactor: vf, segment: segOf(c.exchange, c.symbol) });
  return [
    draft(
      {
        sessionDate: c.istDay, decisionType: decision === 'CARRY' ? 'CARRY' : 'CARRY_EXIT', detector: null, refTable: 'intraday_carry_decisions', refId: c.id,
        userId: c.userId, symbol: c.symbol, underlying: c.underlying, mode: c.mode === 'live' ? 'live' : 'paper', decidedAt: c.decidedAt,
        chosen: decision.toLowerCase(), alternative: decision === 'CARRY' ? 'exit' : 'carry',
        facts: { decision: c.decision, reason: c.reason.slice(0, 300), decisionPrice: c.decisionPrice, priceAt1015: c.priceAt1015, pnlCarryGrossAllQty: c.pnlCarry, lotQty, perLot, valueFactor: vf, source: 'carry-score priceAt1015' },
      },
      g,
    ),
  ];
}

// ─── Re-entries: reentry_watch_decisions (2026-11-05, PAPER) ─────────────────

export interface ReentrySignalSrc {
  id: string;
  underlying: string | null;
  at: Date;
  /** SAME | OPPOSITE */
  direction: string | null;
  tradeId: string | null;
  /** inputs.plan: the entry engine's plan the re-entry was opened with (null when the open was refused). */
  plan: unknown;
}

/**
 * A re-entry SIGNAL graded like ENTRY_TAKE: chosen = taking it (the plan's SL / T1, first touch on the contract's
 * own 1-minute bars, else closed at the session's end), alternative = ₹0. A signal with no plan (the contract was
 * refused) is UNSCORABLE.
 */
export function reentryDrafts(r: ReentrySignalSrc, bars: BarLookup, now: number): DecisionGradeDraft[] {
  const plan = obj(r.plan);
  const exchange = str(plan.exchange);
  const symbol = str(plan.tradingsymbol);
  const decidedAt = r.at.getTime();
  const sessionDate = istYmd(decidedAt);
  const endTs = sessionEndTs(sessionDate, exchange);
  if (!horizonOver('close', decidedAt, now, endTs)) return [];
  const vf = contractValueFactor(exchange, symbol);
  const entry = num(plan.ltp) ?? num(plan.limitPrice);
  const lotQty = num(plan.lotSize) ?? 0;
  const sl = num(plan.sl);
  const targets = Array.isArray(plan.targets) ? plan.targets.map(num).filter((x): x is number => x !== null) : [];
  const t: TakeOutcome = !symbol || entry === null
    ? { pnl: null, outcome: null, reason: 'no plan (the re-entry contract was refused)' }
    : takeOutcome({
      side: 'BUY', entry, entryTs: decidedAt, sl: sl !== null && sl > 0 ? sl : null, targets, lotQty, valueFactor: vf, segment: segOf(exchange, symbol),
      cap: null, tick: num(plan.tickSize) ?? undefined, path: bars(exchange, str(plan.token)), endTs,
    });
  return [
    draft(
      {
        sessionDate, decisionType: 'REENTRY', detector: null, refTable: 'reentry_watch_decisions', refId: r.id, userId: null, symbol, underlying: r.underlying,
        mode: 'paper', decidedAt: r.at, chosen: 'take', alternative: 'skip',
        facts: { direction: r.direction, tradeId: r.tradeId, entry, sl, targets, lotQty, valueFactor: vf, method: 'contract-1m', outcome: t.outcome ? { result: t.outcome.result, stop: t.outcome.stop, price: t.outcome.price, at: t.outcome.at } : null },
      },
      gradeTake({ outcome: t }),
    ),
  ];
}
