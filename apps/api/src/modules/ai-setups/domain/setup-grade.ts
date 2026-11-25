import { istYmd } from '../../mbm/domain/chain-snapshot';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { MCX_LAST_VALID, NSE_LAST_VALID } from './setup-checks';
import { BAR_15M_MS, filledStep, pendingStep, worstFillLevel, type Bar15m, type SetupWatchState } from './setup-watch';
import type { SetupPlan } from './setup.types';

/**
 * Nightly grading of AI setups and NO_TRADE decisions (plan 2026-11-25 Task 6, spec §5.6). Pure.
 *
 * - SETUP rows: the ACTUAL paper result from the Trade row (net = trades.pnl − trades.fees: pnl is gross by design,
 *   fees hold the paper entry + exit charges) — this is what the live gate counts — and a PLAN-ONLY replay of the
 *   setup's own levels on the underlying's closed 15m bars.
 * - NO_TRADE rows (labelled `whatIf.hypothetical`, never mixed into real results): a setup a code check vetoed is
 *   replayed as it was written; a NO_TRADE with no setup gets a NEUTRAL REFERENCE trade (REFERENCE_DEFINITION).
 *
 * The replay uses the setup watch's own rules (pendingStep / filledStep / worstFillLevel), walked over each closed
 * 15m bar as a price path, ADVERSE EXTREME FIRST (CE view: open → low → high → close; PE: open → high → low → close),
 * with the pullback zone's near edge inserted when the bar passed through it. The bar the setup was made in counts
 * only by its close (its range may predate the setup). Exits at a level are priced AT the level (or at the open when
 * the open gapped beyond it); TIME at the close of the bar ending at validUntil; MARKET_NOW fills at the decision LTP.
 *
 * Plan-only / what-if ₹ = (exit − fill underlying, signed for the view) × |delta| × lot size — the same delta × lot
 * approximation the ceiling check uses; GROSS, no charges, no premium decay. Missing delta / lot ⇒ ₹ null (said why).
 *
 * The ACTUAL result is graded on its own readiness: a SETUP row is GRADED (and counts toward the gate) as soon as its
 * trade is closed or it expired unfilled. Missing bars (a gap, bars not yet in, the loader failing) keep only the
 * plan-only / what-if PART pending, retried on later sessions; after MAX_GRADE_SESSIONS distinct sessions that part is
 * UNGRADABLE with the reason — never a guessed result. The live gate counts FILLED setups only (LIVE_GATE_MIN_TRADED).
 */

export const GRADE_VERSION = 1;
/** Distinct sessions a grade may stay pending before it is UNGRADABLE. */
export const MAX_GRADE_SESSIONS = 5;
/** The live gate (spec §7 + controller ruling): at least this many FILLED (traded) setups, cumulative actual net > 0, owner OK. */
export const LIVE_GATE_MIN_TRADED = 20;

export const REFERENCE_DEFINITION =
  'neutral reference (no AI setup): MARKET_NOW at the setup packet LTP in the claim direction (BULL = CE, BEAR = PE), ' +
  'SL and one target at 1 × ATR15m from it, valid until the intraday cut-off; ₹ with the ATM option delta × lot';

export type GradeKind = 'SETUP' | 'NO_TRADE_VETOED' | 'NO_TRADE_REFERENCE';
export type ExchangeFamily = 'NSE' | 'MCX';

/** One ai_setups row as the grader reads it. */
export interface GradeRow {
  id: string;
  underlying: string;
  decision: string;
  status: string;
  setup: unknown;
  checks: unknown;
  packet: unknown;
  tradeId: string | null;
  validUntil: Date | null;
  createdAt: Date;
  exitReason: string | null;
  pnl: number | null;
  grade: unknown;
}

/** The setup's paper trade. */
export interface GradeTrade {
  id: string;
  status: string;
  pnl: number | null;
  fees: number | null;
  exitReasonTag: string | null;
  isPaperTrade: boolean;
}

export type ReplayResult =
  | { status: 'MISSING_BARS'; reason: string }
  | { status: 'DONE'; filled: false; reason: string }
  | {
      status: 'DONE';
      filled: true;
      fillAt: string;
      fillUnderlying: number;
      exit: 'SL' | 'TARGET' | 'TIME';
      /** SL | T1_THEN_STOP | T<n> (the last target) | TIME | T1_THEN_TIME. */
      outcome: string;
      trailed: boolean;
      exitAt: string;
      exitUnderlying: number;
      /** Underlying points in the view's favour (CE: exit − fill; PE: fill − exit). */
      points: number;
      reason: string;
    };

export interface PlanResult {
  filled: boolean;
  /** Why not filled / how it exited. */
  reason: string;
  fillAt?: string;
  fillUnderlying?: number;
  exit?: 'SL' | 'TARGET' | 'TIME';
  outcome: string;
  trailed?: boolean;
  exitAt?: string;
  exitUnderlying?: number;
  points: number;
  delta: number | null;
  lotSize: number | null;
  /** points × |delta| × lotSize, gross; null when delta / lot is missing. */
  rupees: number | null;
  rupeesNote?: string;
}

export interface ActualResult {
  filled: boolean;
  exitReason: string | null;
  tradeId: string | null;
  pnlGross: number;
  fees: number;
  /** pnlGross − fees. */
  net: number;
}

export interface SetupGrade {
  status: 'GRADED' | 'PENDING' | 'UNGRADABLE';
  version: number;
  kind: GradeKind;
  /** The IST session date of the last attempt. */
  session: string;
  at: string;
  /** Distinct IST session dates this row was attempted on. */
  sessionsTried: string[];
  reason?: string;
  actual?: ActualResult;
  plan?: PlanPart;
  whatIf?: PlanPart & { hypothetical: true; reference?: string };
  rupeesFormula?: string;
}

/** The plan-only / what-if part, graded on its own (bars) readiness. */
export type PlanPart =
  | (PlanResult & { status: 'GRADED' })
  | { status: 'PENDING' | 'UNGRADABLE'; reason: string; sessionsTried: string[] };

export const RUPEES_FORMULA = '(exit − fill underlying, signed for the view) × |delta| × lot size; gross, no charges';

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const istHm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
const valueOf = (b: unknown): Record<string, unknown> | null => (isRec(b) && b.status === 'present' && isRec(b.value) ? b.value : null);

export const isPlan = (v: unknown): v is SetupPlan => {
  const s = v as SetupPlan | null;
  return (
    !!s && typeof s === 'object' && !!s.instrument && (s.instrument.optionType === 'CE' || s.instrument.optionType === 'PE') &&
    !!s.entry && typeof s.entry.type === 'string' && Number.isFinite(s.entry.low) && Number.isFinite(s.entry.high) && Number.isFinite(s.sl) &&
    Array.isArray(s.targets) && s.targets.length > 0 && s.targets.every((t) => Number.isFinite(t))
  );
};

/** NSE (NFO / BFO / NSE) or MCX: which night cron grades the row. */
export function familyOf(row: Pick<GradeRow, 'underlying' | 'packet' | 'checks'>): ExchangeFamily {
  const p = isRec(row.packet) ? row.packet : null;
  const c = isRec(row.checks) && isRec(row.checks.context) ? row.checks.context : null;
  const ex = String(p?.optionExchange ?? c?.exchange ?? segmentFor({ underlying: row.underlying, instrumentKind: 'FUT' })).toUpperCase();
  return ex === 'MCX' ? 'MCX' : 'NSE';
}

/** SETUP (the AI made one and the checks passed), NO_TRADE_VETOED (the AI made one, a check vetoed it), NO_TRADE_REFERENCE (the AI said NO_TRADE); null = not graded (SKIPPED). */
export function gradeKindOf(row: Pick<GradeRow, 'decision' | 'status' | 'setup'>): GradeKind | null {
  if (row.status === 'SKIPPED' || (row.decision !== 'SETUP' && row.decision !== 'NO_TRADE')) return null;
  if (row.status !== 'NO_TRADE') return row.decision === 'SETUP' ? 'SETUP' : null;
  return row.decision === 'SETUP' && row.setup ? 'NO_TRADE_VETOED' : 'NO_TRADE_REFERENCE';
}

/** 'HH:mm' IST on the row's IST day, clamped to the intraday cut-off (15:15 NSE / 23:00 MCX); unreadable ⇒ the cut-off. */
export function validUntilFor(createdAt: Date, hhmm: unknown, family: ExchangeFamily): Date {
  const last = family === 'MCX' ? MCX_LAST_VALID : NSE_LAST_VALID;
  const s = typeof hhmm === 'string' && /^\d{2}:\d{2}$/.test(hhmm.trim()) ? hhmm.trim() : last;
  return new Date(`${istYmd(createdAt)}T${s > last ? last : s}:00+05:30`);
}

/** The neutral reference trade for a NO_TRADE without a setup (REFERENCE_DEFINITION). */
export function referencePlan(
  packet: unknown,
  bias: unknown,
  family: ExchangeFamily,
): { ok: true; setup: SetupPlan; fill: number; delta: number | null; lotSize: number | null; definition: string } | { ok: false; reason: string } {
  const p = isRec(packet) ? packet : {};
  if (bias !== 'BULL' && bias !== 'BEAR') return { ok: false, reason: `no reference trade: the claim bias is ${String(bias)} (needs BULL / BEAR)` };
  const ltp = num(valueOf(p.quote)?.ltp);
  if (ltp === null || !(ltp > 0)) return { ok: false, reason: 'no reference trade: the setup packet has no underlying LTP (quote unavailable)' };
  const atr = num(valueOf(p.bars15m)?.atr15m);
  if (atr === null || !(atr > 0)) return { ok: false, reason: 'no reference trade: the setup packet has no ATR15m (15m bars unavailable)' };
  const bull = bias === 'BULL';
  const chain = valueOf(p.chain);
  const rows = Array.isArray(chain?.rows) ? (chain!.rows as unknown[]).filter(isRec) : [];
  const atm = rows.filter((r) => num(r.strike) !== null).sort((a, b) => Math.abs((a.strike as number) - ltp) - Math.abs((b.strike as number) - ltp))[0];
  const leg = atm && isRec(atm[bull ? 'ce' : 'pe']) ? (atm[bull ? 'ce' : 'pe'] as Record<string, unknown>) : null;
  const delta = num(leg?.delta);
  const setup: SetupPlan = {
    instrument: { kind: 'OPT', symbol: String(p.underlying ?? ''), strike: num(atm?.strike) ?? 0, optionType: bull ? 'CE' : 'PE', expiry: String(chain?.expiry ?? '') },
    side: 'BUY',
    entry: { type: 'MARKET_NOW', low: ltp, high: ltp, trigger: null, level: ltp },
    sl: r2(bull ? ltp - atr : ltp + atr),
    targets: [r2(bull ? ltp + atr : ltp - atr)],
    validUntil: family === 'MCX' ? MCX_LAST_VALID : NSE_LAST_VALID,
    confidence: 0,
    evidence: [],
  };
  return { ok: true, setup, fill: ltp, delta: delta === null ? null : Math.abs(delta), lotSize: num(chain?.lotSize), definition: REFERENCE_DEFINITION };
}

interface PathPoint {
  px: number;
  open: boolean;
}

/** A bar as a price path, adverse extreme first; the pullback zone's near edge inserted when the bar passed through it. */
function pathOf(b: Bar15m, s: SetupPlan, pending: boolean): PathPoint[] {
  const bull = s.instrument.optionType === 'CE';
  const pts: PathPoint[] = [{ px: b.open, open: true }];
  if (pending && s.entry.type === 'LIMIT_PULLBACK') {
    if (bull && b.open > s.entry.high && b.low <= s.entry.high) pts.push({ px: s.entry.high, open: false });
    if (!bull && b.open < s.entry.low && b.high >= s.entry.low) pts.push({ px: s.entry.low, open: false });
  }
  if (bull) pts.push({ px: b.low, open: false }, { px: b.high, open: false });
  else pts.push({ px: b.high, open: false }, { px: b.low, open: false });
  pts.push({ px: b.close, open: false });
  return pts;
}

/**
 * Replays a setup on closed 15m bars with the watch's rules. Needs every 15m slot from the setup's bar to the outcome
 * (or to validUntil); a slot with no closed bar ⇒ MISSING_BARS.
 */
export function replayPlan(i: { setup: SetupPlan; createdAt: Date; validUntil: Date; bars: readonly Bar15m[]; now: Date; marketFill?: number | null }): ReplayResult {
  const s = i.setup;
  const bull = s.instrument.optionType === 'CE';
  const created = i.createdAt.getTime();
  const end = i.validUntil.getTime();
  const byTs = new Map<number, Bar15m>();
  for (const b of i.bars) {
    if (![b.ts, b.open, b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (b.ts + BAR_15M_MS <= i.now.getTime()) byTs.set(b.ts, b);
  }
  const done = (fill: { at: number; px: number }, exit: 'SL' | 'TARGET' | 'TIME', trailed: boolean, at: number, px: number, reason: string): ReplayResult => {
    const outcome = exit === 'TARGET' ? `T${s.targets.length}` : exit === 'SL' ? (trailed ? 'T1_THEN_STOP' : 'SL') : trailed ? 'T1_THEN_TIME' : 'TIME';
    return {
      status: 'DONE', filled: true, fillAt: new Date(fill.at).toISOString(), fillUnderlying: fill.px, exit, outcome, trailed,
      exitAt: new Date(at).toISOString(), exitUnderlying: px, points: r2(bull ? px - fill.px : fill.px - px), reason,
    };
  };

  if (created >= end) return { status: 'DONE', filled: false, reason: `VALID_UNTIL_PASSED: valid until ${istHm(end)} IST was not after the setup (${istHm(created)} IST)` };
  let fill: { at: number; px: number } | null = null;
  let watch: SetupWatchState | null = null;
  if (s.entry.type === 'MARKET_NOW' && i.marketFill != null && i.marketFill > 0 && created < end) {
    fill = { at: created, px: i.marketFill };
    watch = { sl: s.sl, trailed: false, worstFill: worstFillLevel(s, i.marketFill) };
  }
  const closed: Bar15m[] = [];
  let lastClose: number | null = null;
  const slot0 = Math.floor(created / BAR_15M_MS) * BAR_15M_MS;
  for (let slot = slot0; ; slot += BAR_15M_MS) {
    // Only bars that END by validUntil are walked: no price from after validUntil is used.
    if (slot + BAR_15M_MS > end) {
      if (!fill || !watch) {
        const step = pendingStep({ setup: s, ltp: null, now: new Date(Math.max(slot, end)), validUntil: i.validUntil, createdAt: i.createdAt });
        return { status: 'DONE', filled: false, reason: step.reason };
      }
      const px = lastClose ?? fill.px;
      return done(fill, 'TIME', watch.trailed, end, px, `valid until ${istHm(end)} IST reached at underlying ${px}`);
    }
    const b = byTs.get(slot);
    if (!b) return { status: 'MISSING_BARS', reason: `no closed 15m bar for ${istYmd(new Date(slot))} ${istHm(slot)} IST` };
    const partial = slot < created;
    const pts: PathPoint[] = partial ? [{ px: b.close, open: false }] : pathOf(b, s, !fill);
    for (const p of pts) {
      if (!fill || !watch) {
        const step = pendingStep({ setup: s, ltp: p.px, now: new Date(slot), validUntil: i.validUntil, createdAt: i.createdAt, bars15m: closed });
        if (step.action === 'WAIT') continue;
        if (step.action === 'EXPIRE') return { status: 'DONE', filled: false, reason: step.reason };
        fill = { at: partial ? slot + BAR_15M_MS : slot, px: p.px };
        watch = { sl: s.sl, trailed: false, worstFill: worstFillLevel(s, p.px) };
        continue;
      }
      const step = filledStep({ setup: s, watch, ltp: p.px, now: new Date(slot), validUntil: i.validUntil, minutesToClose: null });
      if (step.action === 'HOLD') continue;
      if (step.action === 'TRAIL') {
        watch = { ...watch, sl: step.sl, trailed: true };
        continue;
      }
      const level = step.tag === 'AI_SETUP_SL' ? watch.sl : s.targets[s.targets.length - 1];
      const px = p.open || step.tag === 'AI_SETUP_TIME' ? p.px : level;
      const exit = step.tag === 'AI_SETUP_SL' ? 'SL' : step.tag === 'AI_SETUP_TARGET' ? 'TARGET' : 'TIME';
      return done(fill, exit, watch.trailed, slot, px, step.reason);
    }
    closed.push(b);
    lastClose = b.close;
  }
}

function planResult(r: Exclude<ReplayResult, { status: 'MISSING_BARS' }>, delta: number | null, lotSize: number | null): PlanResult {
  const d = delta === null ? null : Math.abs(delta);
  const lot = lotSize !== null && lotSize > 0 ? lotSize : null;
  const base = r.filled
    ? { filled: true, reason: r.reason, fillAt: r.fillAt, fillUnderlying: r.fillUnderlying, exit: r.exit, outcome: r.outcome, trailed: r.trailed, exitAt: r.exitAt, exitUnderlying: r.exitUnderlying, points: r.points }
    : { filled: false, reason: r.reason, outcome: 'NOT_FILLED', points: 0 };
  if (!r.filled) return { ...base, delta: d, lotSize: lot, rupees: 0 };
  if (d === null || lot === null) {
    return { ...base, delta: d, lotSize: lot, rupees: null, rupeesNote: `no ₹: ${d === null ? 'option delta' : 'lot size'} missing from the setup's check context / packet` };
  }
  return { ...base, delta: d, lotSize: lot, rupees: r2(base.points * d * lot) };
}

/** The actual paper result; not ready while the row or its trade is still live. */
export function actualResult(row: GradeRow, trade: GradeTrade | null): { ready: true; actual: ActualResult } | { ready: false; reason: string } {
  if (row.status === 'PENDING' || row.status === 'FILLED') return { ready: false, reason: `setup still ${row.status} (the watch has not finished it)` };
  if (!row.tradeId) return { ready: true, actual: { filled: false, exitReason: row.exitReason, tradeId: null, pnlGross: 0, fees: 0, net: 0 } };
  if (!trade) return { ready: false, reason: `paper trade ${row.tradeId} not found` };
  if (trade.status !== 'CLOSED' || trade.pnl === null) return { ready: false, reason: `paper trade ${trade.id} is ${trade.status}${trade.pnl === null ? ' with no P&L' : ''}` };
  const fees = num(trade.fees) ?? 0;
  return { ready: true, actual: { filled: true, exitReason: trade.exitReasonTag ?? row.exitReason, tradeId: trade.id, pnlGross: r2(trade.pnl), fees: r2(fees), net: r2(trade.pnl - fees) } };
}

const priorSessions = (g: unknown): string[] => (isRec(g) && Array.isArray(g.sessionsTried) ? g.sessionsTried.filter((x): x is string => typeof x === 'string') : []);
const partOf = (g: unknown, key: 'plan' | 'whatIf'): Record<string, unknown> | null => (isRec(g) && isRec(g[key]) ? g[key] : null);
const withSession = (xs: string[], session: string) => (xs.includes(session) ? xs : [...xs, session]);

type ReplayInputs =
  | { ok: true; plan: SetupPlan; marketFill: number | null; delta: number | null; lotSize: number | null; validUntil: Date; reference?: string }
  | { ok: false; reason: string; reference?: string };

/** What to replay: the setup itself (SETUP / vetoed) or the neutral reference (plain NO_TRADE). */
function replayInputs(row: GradeRow, kind: GradeKind): ReplayInputs {
  const family = familyOf(row);
  if (kind === 'NO_TRADE_REFERENCE') {
    const p = isRec(row.packet) ? row.packet : {};
    const c = isRec(row.checks) ? row.checks : {};
    const bias = (isRec(p.claim) ? p.claim.bias : undefined) ?? (isRec(c.claim) ? c.claim.bias : undefined);
    const ref = referencePlan({ ...p, underlying: p.underlying ?? row.underlying }, bias, family);
    if (!ref.ok) return { ok: false, reason: ref.reason, reference: REFERENCE_DEFINITION };
    return { ok: true, plan: ref.setup, marketFill: ref.fill, delta: ref.delta, lotSize: ref.lotSize, validUntil: validUntilFor(row.createdAt, ref.setup.validUntil, family), reference: ref.definition };
  }
  if (!isPlan(row.setup)) return { ok: false, reason: 'the stored setup has no readable instrument / entry / SL / targets' };
  const ctx = isRec(row.checks) && isRec(row.checks.context) ? row.checks.context : {};
  return {
    ok: true,
    plan: row.setup,
    marketFill: num(ctx.ltpUnderlying),
    delta: num(ctx.delta),
    lotSize: num(ctx.lotSize),
    validUntil: kind === 'SETUP' && row.validUntil ? row.validUntil : validUntilFor(row.createdAt, row.setup.validUntil, family),
  };
}

interface BuildInput {
  row: GradeRow;
  trade: GradeTrade | null;
  bars: readonly Bar15m[] | null;
  barsError: string | null;
  now: Date;
  session: string;
}

/**
 * The plan-only / what-if part: a prior GRADED or UNGRADABLE part is kept as it was; otherwise replayed — PENDING
 * (its own sessions counted) while bars are missing, UNGRADABLE after MAX_GRADE_SESSIONS of them.
 */
function replayPart(i: BuildInput, kind: GradeKind, prior: Record<string, unknown> | null): { part: PlanPart; reference?: string } {
  const priorRef = typeof prior?.reference === 'string' ? prior.reference : undefined;
  if (prior && (prior.status === 'GRADED' || prior.status === 'UNGRADABLE')) return { part: prior as unknown as PlanPart, reference: priorRef };
  const sessionsTried = withSession(priorSessions(prior), i.session);
  const inp = replayInputs(i.row, kind);
  if (!inp.ok) return { part: { status: 'UNGRADABLE', reason: inp.reason, sessionsTried }, reference: inp.reference };
  let wait: string;
  if (!i.bars) wait = `15m bars unavailable: ${i.barsError ?? 'not read'}`;
  else {
    const r = replayPlan({ setup: inp.plan, createdAt: i.row.createdAt, validUntil: inp.validUntil, bars: i.bars, now: i.now, marketFill: inp.marketFill });
    if (r.status === 'DONE') return { part: { status: 'GRADED', ...planResult(r, inp.delta, inp.lotSize) }, reference: inp.reference };
    wait = r.reason;
  }
  if (sessionsTried.length >= MAX_GRADE_SESSIONS) {
    return { part: { status: 'UNGRADABLE', reason: `still no 15m bars after ${sessionsTried.length} sessions: ${wait}`, sessionsTried }, reference: inp.reference };
  }
  return { part: { status: 'PENDING', reason: wait, sessionsTried }, reference: inp.reference };
}

/**
 * The row's grade this run (null = not a graded kind).
 * - SETUP: GRADED as soon as the ACTUAL result is ready (trade closed, or expired unfilled), whatever the bars say;
 *   the plan-only part may still be PENDING and is filled in on later runs, and an actual already graded is never
 *   changed. The actual still not ready after MAX_GRADE_SESSIONS → UNGRADABLE.
 * - NO_TRADE kinds: the row's status is the what-if's.
 * The cron re-selects rows whose grade, plan or what-if is PENDING; a re-run in the same session counts once.
 */
export function buildGrade(i: BuildInput): SetupGrade | null {
  const { row } = i;
  const kind = gradeKindOf(row);
  if (!kind) return null;
  const prev = isRec(row.grade) ? row.grade : null;
  const sessionsTried = withSession(priorSessions(prev), i.session);
  const head = { version: GRADE_VERSION, kind, session: i.session, at: i.now.toISOString(), sessionsTried, rupeesFormula: RUPEES_FORMULA };

  if (kind !== 'SETUP') {
    const { part, reference } = replayPart(i, kind, partOf(prev, 'whatIf'));
    const whatIf = { ...part, hypothetical: true as const, ...(reference ? { reference } : {}) };
    return { status: part.status, ...head, ...(part.status !== 'GRADED' ? { reason: part.reason } : {}), whatIf };
  }

  const { part: plan } = replayPart(i, kind, partOf(prev, 'plan'));
  const priorActual = prev && prev.status === 'GRADED' && isRec(prev.actual) ? (prev.actual as unknown as ActualResult) : null;
  if (priorActual) return { status: 'GRADED', ...head, actual: priorActual, plan };
  const a = actualResult(row, i.trade);
  if (a.ready) return { status: 'GRADED', ...head, actual: a.actual, plan };
  if (sessionsTried.length >= MAX_GRADE_SESSIONS) {
    return { status: 'UNGRADABLE', ...head, reason: `actual result still not ready after ${sessionsTried.length} sessions: ${a.reason}`, plan };
  }
  return { status: 'PENDING', ...head, reason: a.reason, plan };
}

export interface GateTotals {
  /** GRADED SETUPs with a known actual net (filled or not). */
  gradedSetups: number;
  /** Of those, the ones whose paper trade was opened — what the gate counts. */
  tradedSetups: number;
  actualNet: number;
  gateMin: number;
  gateMet: boolean;
}

/** The running totals toward the live gate: ≥ LIVE_GATE_MIN_TRADED FILLED setups with cumulative actual net > 0. */
export function gateTotals(grades: readonly unknown[]): GateTotals {
  let graded = 0;
  let traded = 0;
  let net = 0;
  for (const g of grades) {
    if (!isRec(g) || g.status !== 'GRADED' || g.kind !== 'SETUP' || !isRec(g.actual)) continue;
    const v = num(g.actual.net);
    if (v === null) continue;
    graded++;
    if (g.actual.filled === true) traded++;
    net += v;
  }
  return { gradedSetups: graded, tradedSetups: traded, actualNet: r2(net), gateMin: LIVE_GATE_MIN_TRADED, gateMet: traded >= LIVE_GATE_MIN_TRADED && net > 0 };
}

const rupeesOf = (p: PlanPart | undefined): number | null => (p && p.status === 'GRADED' ? p.rupees : null);
const newlyGraded = (prev: unknown, g: SetupGrade, key: 'plan' | 'whatIf') => g[key]?.status === 'GRADED' && partOf(prev, key)?.status !== 'GRADED';

/** The one summary line per run, over what this run newly graded (`prev` = the row's grade before the run). */
export function gradeSummaryLine(family: ExchangeFamily, entries: ReadonlyArray<{ prev: unknown; grade: SetupGrade }>, totals: GateTotals): string {
  const sum = (xs: Array<number | null | undefined>) => r2(xs.reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0));
  const actuals = entries.filter((e) => e.grade.kind === 'SETUP' && e.grade.status === 'GRADED' && !(isRec(e.prev) && e.prev.status === 'GRADED' && isRec(e.prev.actual)));
  const plans = entries.filter((e) => newlyGraded(e.prev, e.grade, 'plan')).map((e) => e.grade.plan);
  const whatIfs = entries.filter((e) => newlyGraded(e.prev, e.grade, 'whatIf')).map((e) => e.grade);
  const anyIs = (g: SetupGrade, s: string) => g.status === s || g.plan?.status === s || g.whatIf?.status === s;
  const unpriced = [...plans, ...whatIfs.map((g) => g.whatIf)].filter((p) => p && p.status === 'GRADED' && p.filled && p.rupees === null).length;
  return (
    `[ai-setup-grade] ${family}: setups graded ${actuals.length} / traded ${actuals.filter((e) => e.grade.actual?.filled).length}; ` +
    `actual net ₹${sum(actuals.map((e) => e.grade.actual?.net))}; plan-only net ₹${sum(plans.map(rupeesOf))} (${plans.length} plans); ` +
    `NO_TRADE what-if net ₹${sum(whatIfs.map((g) => rupeesOf(g.whatIf)))} (${whatIfs.length} graded: ${whatIfs.filter((g) => g.kind === 'NO_TRADE_VETOED').length} vetoed, ` +
    `${whatIfs.filter((g) => g.kind === 'NO_TRADE_REFERENCE').length} reference); pending ${entries.filter((e) => anyIs(e.grade, 'PENDING')).length}, ` +
    `ungradable ${entries.filter((e) => anyIs(e.grade, 'UNGRADABLE')).length}${unpriced ? `, ${unpriced} filled without ₹ (no delta / lot)` : ''} | ` +
    `live gate: ${totals.tradedSetups}/${totals.gateMin} traded setups (${totals.gradedSetups} graded), cumulative actual net ₹${totals.actualNet}` +
    `${totals.gateMet ? ' — gate numbers met (owner OK still needed)' : ''}`
  );
}
