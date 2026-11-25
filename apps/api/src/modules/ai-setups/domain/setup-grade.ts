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
 * Missing bars (a gap, bars not yet in, the loader failing) ⇒ the grade stays PENDING and is retried on later
 * sessions; after MAX_GRADE_SESSIONS distinct sessions it is UNGRADABLE with the reason — never a guessed result.
 */

export const GRADE_VERSION = 1;
/** Distinct sessions a grade may stay pending before it is UNGRADABLE. */
export const MAX_GRADE_SESSIONS = 5;
/** The live gate (spec §7): at least this many graded setups, cumulative actual net > 0, owner OK. */
export const LIVE_GATE_MIN_GRADED = 20;

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
  plan?: PlanResult;
  whatIf?: PlanResult & { hypothetical: true; reference?: string };
  rupeesFormula?: string;
}

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
    if (slot >= end) {
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

/**
 * The row's grade this run (null = not a graded kind). GRADED rows are never re-selected by the cron; a PENDING
 * grade records the session it was tried on (a re-run the same session counts once).
 */
export function buildGrade(i: { row: GradeRow; trade: GradeTrade | null; bars: readonly Bar15m[] | null; barsError: string | null; now: Date; session: string }): SetupGrade | null {
  const { row } = i;
  const kind = gradeKindOf(row);
  if (!kind) return null;
  const tried = priorSessions(row.grade);
  const sessionsTried = tried.includes(i.session) ? tried : [...tried, i.session];
  const head = { version: GRADE_VERSION, kind, session: i.session, at: i.now.toISOString(), sessionsTried };
  const ungradable = (reason: string, extra: Partial<SetupGrade> = {}): SetupGrade => ({ status: 'UNGRADABLE', ...head, reason, ...extra });
  const family = familyOf(row);

  // What to replay.
  let plan: SetupPlan;
  let marketFill: number | null;
  let delta: number | null;
  let lotSize: number | null;
  let validUntil: Date;
  let reference: string | undefined;
  if (kind === 'NO_TRADE_REFERENCE') {
    const p = isRec(row.packet) ? row.packet : {};
    const c = isRec(row.checks) ? row.checks : {};
    const bias = (isRec(p.claim) ? p.claim.bias : undefined) ?? (isRec(c.claim) ? c.claim.bias : undefined);
    const ref = referencePlan({ ...p, underlying: p.underlying ?? row.underlying }, bias, family);
    if (!ref.ok) return ungradable(ref.reason);
    plan = ref.setup;
    marketFill = ref.fill;
    delta = ref.delta;
    lotSize = ref.lotSize;
    validUntil = validUntilFor(row.createdAt, plan.validUntil, family);
    reference = ref.definition;
  } else {
    if (!isPlan(row.setup)) return ungradable('the stored setup has no readable instrument / entry / SL / targets');
    plan = row.setup;
    const ctx = isRec(row.checks) && isRec(row.checks.context) ? row.checks.context : {};
    marketFill = num(ctx.ltpUnderlying) ?? null;
    delta = num(ctx.delta);
    lotSize = num(ctx.lotSize);
    validUntil = kind === 'SETUP' && row.validUntil ? row.validUntil : validUntilFor(row.createdAt, plan.validUntil, family);
  }

  // Readiness: the actual result (SETUP) and the bars.
  const waits: string[] = [];
  let actual: ActualResult | undefined;
  if (kind === 'SETUP') {
    const a = actualResult(row, i.trade);
    if (a.ready) actual = a.actual;
    else waits.push(a.reason);
  }
  let replay: ReplayResult | null = null;
  if (!i.bars) waits.push(`15m bars unavailable: ${i.barsError ?? 'not read'}`);
  else {
    replay = replayPlan({ setup: plan, createdAt: row.createdAt, validUntil, bars: i.bars, now: i.now, marketFill });
    if (replay.status === 'MISSING_BARS') waits.push(replay.reason);
  }
  if (waits.length > 0 || !replay || replay.status === 'MISSING_BARS') {
    const reason = waits.join('; ');
    if (sessionsTried.length >= MAX_GRADE_SESSIONS) {
      return ungradable(`still not gradable after ${sessionsTried.length} sessions: ${reason}`, actual ? { actual } : {});
    }
    return { status: 'PENDING', ...head, reason };
  }
  const result = planResult(replay, delta, lotSize);
  if (kind === 'SETUP') return { status: 'GRADED', ...head, actual, plan: result, rupeesFormula: RUPEES_FORMULA };
  return { status: 'GRADED', ...head, whatIf: { ...result, hypothetical: true, ...(reference ? { reference } : {}) }, rupeesFormula: RUPEES_FORMULA };
}

/** The running totals toward the live gate: graded SETUPs with a known actual net, and its sum. */
export function gateTotals(grades: readonly unknown[]): { gradedSetups: number; actualNet: number; gateMin: number; gateMet: boolean } {
  let n = 0;
  let net = 0;
  for (const g of grades) {
    if (!isRec(g) || g.status !== 'GRADED' || g.kind !== 'SETUP' || !isRec(g.actual)) continue;
    const v = num(g.actual.net);
    if (v === null) continue;
    n++;
    net += v;
  }
  return { gradedSetups: n, actualNet: r2(net), gateMin: LIVE_GATE_MIN_GRADED, gateMet: n >= LIVE_GATE_MIN_GRADED && net > 0 };
}

/** The one summary line per run. */
export function gradeSummaryLine(family: ExchangeFamily, grades: readonly SetupGrade[], totals: ReturnType<typeof gateTotals>, extra: { pending?: number; ungradable?: number } = {}): string {
  const graded = grades.filter((g) => g.status === 'GRADED');
  const setups = graded.filter((g) => g.kind === 'SETUP');
  const sum = (xs: Array<number | null | undefined>) => r2(xs.reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0));
  const unpriced = graded.filter((g) => (g.plan ?? g.whatIf)?.filled && (g.plan ?? g.whatIf)?.rupees === null).length;
  const whatIfs = graded.filter((g) => g.kind !== 'SETUP');
  return (
    `[ai-setup-grade] ${family}: setups graded ${setups.length}, filled ${setups.filter((g) => g.actual?.filled).length}, ` +
    `actual net ₹${sum(setups.map((g) => g.actual?.net))}, plan-only net ₹${sum(setups.map((g) => g.plan?.rupees))}; ` +
    `NO_TRADE what-if net ₹${sum(whatIfs.map((g) => g.whatIf?.rupees))} (${whatIfs.length} graded: ${whatIfs.filter((g) => g.kind === 'NO_TRADE_VETOED').length} vetoed, ` +
    `${whatIfs.filter((g) => g.kind === 'NO_TRADE_REFERENCE').length} reference); pending ${extra.pending ?? grades.filter((g) => g.status === 'PENDING').length}, ` +
    `ungradable ${extra.ungradable ?? grades.filter((g) => g.status === 'UNGRADABLE').length}${unpriced ? `, ${unpriced} filled without ₹ (no delta / lot)` : ''} | ` +
    `live gate: ${totals.gradedSetups}/${totals.gateMin} graded setups, cumulative actual net ₹${totals.actualNet}${totals.gateMet ? ' — gate numbers met (owner OK still needed)' : ''}`
  );
}
