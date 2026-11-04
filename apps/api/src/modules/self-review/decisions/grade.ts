/**
 * Pure graders for the decision ledger (plan 2026-11-04 stream F, task F1). Each grades ONE decision
 * against the other choice in real ₹ for ONE lot, net of charges:
 *   - real ₹ = price points × lotQty × valueFactor (`contractValueFactor` from @td/shared: 100 for MCX
 *     GOLD, whose master lot is 1 — a GOLD premium point is ₹100, not ₹1);
 *   - charges = trade-sentinel/charges.ts (the exit leg for exit-vs-hold, the round trip for take-vs-skip).
 * delta = alternative − chosen. WRONG when the alternative beat the chosen action by ≥ ₹500 per lot or
 * by ≥ 1 contract noise unit (isWrong). A decision without the prices to judge it is UNSCORABLE with a
 * reason — never RIGHT (a missing path must never count as a good decision or feed a setting change).
 * Read-only analysis: nothing here places, sizes or blocks an order.
 */
import { contractPathFromBars, fairCheck, MAX_GAP_MS, type FairCheck, type StopOutcome } from '../../signal-trader/domain/fair-score';
import { chargesForLeg, estimateCharges, type Segment } from '../../trade-sentinel/charges';
import type { Bar, Grade, Horizon } from './types';

/** ₹ per lot the alternative must beat the chosen action by (owner rule, spec goal 2). */
export const WRONG_RUPEES = 500;

const MIN = 60_000;
export const HORIZON_MS: Readonly<Record<'15m' | '30m' | '60m', number>> = Object.freeze({ '15m': 15 * MIN, '30m': 30 * MIN, '60m': 60 * MIN });
export const EXIT_HORIZONS: readonly Horizon[] = ['15m', '30m', '60m'];

const r2 = (n: number) => Math.round(n * 100) / 100;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pos = (x: unknown): x is number => fin(x) && x > 0;
const vfOf = (f: number) => (pos(f) ? f : 1);

/**
 * The owner's WRONG rule: delta ≥ ₹500 per lot, OR delta ≥ one contract noise unit in ₹ (when known).
 * Taken literally from the plan's Global Constraints: the noise unit can only LOWER the bar below ₹500.
 * A null / non-finite delta is never wrong (it is UNSCORABLE upstream).
 */
export function isWrong(deltaRupees: number | null, noiseUnitRupees: number | null): boolean {
  if (!fin(deltaRupees)) return false;
  if (deltaRupees >= WRONG_RUPEES) return true;
  return pos(noiseUnitRupees) && deltaRupees >= noiseUnitRupees;
}

/** One contract noise unit (contract points) → ₹ per lot; null when unknown. */
export function noiseUnitRupees(noiseUnit: number | null | undefined, lotQty: number, valueFactor: number): number | null {
  return pos(noiseUnit) && pos(lotQty) ? r2(noiseUnit * lotQty * vfOf(valueFactor)) : null;
}

const unscorable = (horizon: Horizon, reason: string): Grade => ({ horizon, pnlChosen: null, pnlAlternative: null, deltaRupees: null, verdict: 'UNSCORABLE', reason });

function verdictOf(horizon: Horizon, pnlChosen: number, pnlAlternative: number, noiseRupees: number | null, what: string): Grade {
  const delta = r2(pnlAlternative - pnlChosen);
  const wrong = isWrong(delta, noiseRupees);
  const bar = noiseRupees !== null ? `₹${WRONG_RUPEES} or 1 noise unit ₹${noiseRupees}` : `₹${WRONG_RUPEES}`;
  return {
    horizon,
    pnlChosen: r2(pnlChosen),
    pnlAlternative: r2(pnlAlternative),
    deltaRupees: delta,
    verdict: wrong ? 'WRONG' : 'RIGHT',
    reason: `${what}: the other choice ${delta >= 0 ? 'better' : 'worse'} by ₹${Math.abs(delta)} per lot net (WRONG at ≥ ${bar})`,
  };
}

// ─── Prices along a path ─────────────────────────────────────────────────────

/**
 * The close at `fromTs + spanMs`: the last bar that STARTS after the decision's minute and ENDS by the
 * horizon. The bars must cover the window densely (no gap over MAX_GAP_MS at its start, inside, or at its
 * end — the fair-score rule), else null with the reason. The decision minute itself is not used (its part
 * before the decision already happened).
 */
export function priceAt(path: readonly Bar[] | null | undefined, fromTs: number, spanMs: number): { price: number | null; reason: string } {
  if (!path || path.length === 0) return { price: null, reason: 'missing bars: no price path stored' };
  const startMin = Math.floor(fromTs / MIN) * MIN + MIN;
  const end = fromTs + spanMs;
  const bars = path.filter((b) => b.ts >= startMin && b.ts + MIN <= end && pos(b.close)).sort((a, b) => a.ts - b.ts);
  if (bars.length === 0) return { price: null, reason: `missing bars: none in the ${Math.round(spanMs / MIN)} min after the decision` };
  let last = fromTs;
  for (const b of bars) {
    if (b.ts - last > MAX_GAP_MS) return { price: null, reason: `missing bars: a ${Math.round((b.ts - last) / MIN)} min gap in the path` };
    last = b.ts + MIN;
  }
  if (end - last > MAX_GAP_MS) return { price: null, reason: `missing bars: the path ends ${Math.round((end - last) / MIN)} min before the horizon` };
  return { price: bars[bars.length - 1].close, reason: 'ok' };
}

/** ₹ of the closing leg of a position at `price` for one lot (the leg that sells a LONG / buys back a SHORT). */
function exitLeg(segment: Segment, side: 'LONG' | 'SHORT', price: number, lotQty: number, valueFactor: number): number {
  return chargesForLeg({ segment, leg: side === 'LONG' ? 'SELL' : 'BUY', price, qty: lotQty, valueFactor: vfOf(valueFactor) }).total;
}

/** ₹ per lot, net of the closing leg, of holding from `from` to `to` (measured from the decision point). */
function holdPnl(i: { side: 'LONG' | 'SHORT'; from: number; to: number; lotQty: number; valueFactor: number; segment: Segment }): number {
  const sign = i.side === 'SHORT' ? -1 : 1;
  return sign * (i.to - i.from) * i.lotQty * vfOf(i.valueFactor) - exitLeg(i.segment, i.side, i.to, i.lotQty, i.valueFactor);
}

/** ₹ per lot, net, of closing at the decision price: just the closing leg's charges. */
function exitNowPnl(i: { side: 'LONG' | 'SHORT'; at: number; lotQty: number; valueFactor: number; segment: Segment }): number {
  return -exitLeg(i.segment, i.side, i.at, i.lotQty, i.valueFactor);
}

// ─── Exit vs hold ────────────────────────────────────────────────────────────

export interface ExitGradeInput {
  side: 'LONG' | 'SHORT';
  /** The contract price the decision was taken at (the exit fill / the decision LTP). */
  exitPrice: number;
  /** ms epoch of the decision. */
  decidedAt: number;
  /** The position's quantity (record only: grading is per lot). */
  qty?: number;
  lotQty: number;
  valueFactor: number;
  segment: Segment;
  path: readonly Bar[] | null;
  /** Precomputed horizon prices (ai_exit_outcomes closeAt15/30/60) — used where given, the path elsewhere. */
  closes?: Partial<Record<Horizon, number | null>>;
  /** One contract noise unit in contract points (the gate's nContract), when known. */
  noiseUnit?: number | null;
  /** 'exit' (default): the decision exited, the alternative is holding. 'hold': the decision held (HOLD / a gated exit). */
  chosen?: 'exit' | 'hold';
  horizons?: readonly Horizon[];
}

/** Exit now vs hold to +15 / +30 / +60 min, one Grade per horizon. */
export function gradeExit(i: ExitGradeInput): Grade[] {
  const horizons = i.horizons ?? EXIT_HORIZONS;
  const chosen = i.chosen ?? 'exit';
  return horizons.map((h) => {
    if (h !== '15m' && h !== '30m' && h !== '60m') return unscorable(h, `horizon ${h} is not an exit horizon`);
    if (!pos(i.exitPrice)) return unscorable(h, 'no decision price');
    if (!pos(i.lotQty)) return unscorable(h, 'no lot size');
    const given = i.closes?.[h];
    const at = pos(given) ? { price: given, reason: 'ok' } : priceAt(i.path, i.decidedAt, HORIZON_MS[h]);
    if (at.price === null) return unscorable(h, at.reason);
    const base = { side: i.side, lotQty: i.lotQty, valueFactor: i.valueFactor, segment: i.segment };
    const now = exitNowPnl({ ...base, at: i.exitPrice });
    const hold = holdPnl({ ...base, from: i.exitPrice, to: at.price });
    const noise = noiseUnitRupees(i.noiseUnit, i.lotQty, i.valueFactor);
    const what = `${chosen === 'exit' ? 'exited' : 'held'} at ${i.exitPrice}, ${h} later ${at.price}`;
    return chosen === 'exit' ? verdictOf(h, now, hold, noise, what) : verdictOf(h, hold, now, noise, what);
  });
}

/**
 * A gated / awaiting exit call (the gate held the position) vs exiting at the gated call's price, judged
 * at the position's eventual exit. No eventual exit yet ⇒ UNSCORABLE.
 */
export function gradeGated(i: {
  side: 'LONG' | 'SHORT';
  gatedPrice: number;
  eventualExit: number | null;
  lotQty: number;
  valueFactor: number;
  segment: Segment;
  noiseUnit?: number | null;
}): Grade {
  if (!pos(i.gatedPrice)) return unscorable('close', 'no gated-call price');
  if (!pos(i.eventualExit)) return unscorable('close', 'no eventual exit yet (position open, or its exit price is not stored)');
  if (!pos(i.lotQty)) return unscorable('close', 'no lot size');
  const base = { side: i.side, lotQty: i.lotQty, valueFactor: i.valueFactor, segment: i.segment };
  const held = holdPnl({ ...base, from: i.gatedPrice, to: i.eventualExit });
  const exitThen = exitNowPnl({ ...base, at: i.gatedPrice });
  return verdictOf('close', held, exitThen, noiseUnitRupees(i.noiseUnit, i.lotQty, i.valueFactor), `gated at ${i.gatedPrice}, eventually exited at ${i.eventualExit}`);
}

/**
 * The intraday close CARRY / EXIT, from the carry scorer's own next-session price (priceAt1015 — reused,
 * not recomputed): carry = hold from the decision price to 10:15 IST next session; exit = close at the
 * decision price. Net of the closing leg (carry-score itself is gross).
 */
export function gradeCarry(i: {
  decision: 'CARRY' | 'EXIT';
  side: 'LONG' | 'SHORT';
  decisionPrice: number | null;
  priceAt1015: number | null;
  lotQty: number;
  valueFactor: number;
  segment: Segment;
  noiseUnit?: number | null;
}): Grade {
  if (!pos(i.decisionPrice)) return unscorable('next1h', 'no decision price');
  if (!pos(i.priceAt1015)) return unscorable('next1h', 'no next-session price (not scored yet, or no bars)');
  if (!pos(i.lotQty)) return unscorable('next1h', 'no lot size');
  const base = { side: i.side, lotQty: i.lotQty, valueFactor: i.valueFactor, segment: i.segment };
  const carry = holdPnl({ ...base, from: i.decisionPrice, to: i.priceAt1015 });
  const exit = exitNowPnl({ ...base, at: i.decisionPrice });
  const noise = noiseUnitRupees(i.noiseUnit, i.lotQty, i.valueFactor);
  const what = `${i.decision} at ${i.decisionPrice}, next session 10:15 ${i.priceAt1015}`;
  return i.decision === 'CARRY' ? verdictOf('next1h', carry, exit, noise, what) : verdictOf('next1h', exit, carry, noise, what);
}

// ─── Take vs skip ────────────────────────────────────────────────────────────

export interface EntryGradeInput {
  side: 'BUY' | 'SELL';
  entry: number;
  /** ms epoch of the decision (the would-be fill). */
  entryTs: number;
  /** The plan's SL (none ⇒ only the cap-sized stop). */
  sl: number | null;
  targets: readonly number[];
  lotQty: number;
  valueFactor: number;
  segment: Segment;
  /** caps.maxLossPerTrade, ₹ for one lot. */
  cap: number | null;
  tick?: number;
  /** The contract's 1-minute bars from the decision onward. */
  path: readonly Bar[] | null;
  /** Where an untouched trade is closed: the session's end (ms). */
  endTs: number;
}

export interface TakeOutcome {
  /** ₹ per lot, net of the round trip; null when it cannot be scored. */
  pnl: number | null;
  /** The fair replay's outcome for the cap-sized stop (target / stop first touch). */
  outcome: StopOutcome | null;
  reason: string;
}

/**
 * What TAKING the call would have made for one lot: the cap-sized stop (fair-score.ts) and the plan's
 * first target, first touch on the contract's own bars, else closed at the session's last bar. The fair
 * replay is fed lotQty × valueFactor so that the cap-sized stop is sized in REAL ₹ (2026-11-04: fair-score
 * divides the cap by lotQty alone — on GOLD, lot 1 × ₹100/pt, that put the "cap" stop 100× too wide).
 */
export function takeOutcome(i: EntryGradeInput): TakeOutcome {
  if (!pos(i.entry)) return { pnl: null, outcome: null, reason: 'no entry price' };
  if (!pos(i.lotQty)) return { pnl: null, outcome: null, reason: 'no lot size' };
  if (!i.path || i.path.length === 0) return { pnl: null, outcome: null, reason: 'missing bars: no contract price path stored' };
  const vf = vfOf(i.valueFactor);
  const inSession = i.path.filter((b) => b.ts + MIN <= i.endTs && pos(b.close)).sort((a, b) => a.ts - b.ts);
  const last = inSession[inSession.length - 1];
  if (!last || last.ts + MIN <= i.entryTs) return { pnl: null, outcome: null, reason: 'missing bars: none after the decision in the session' };
  const fair: FairCheck = fairCheck({
    aiDecision: 'TAKE',
    side: i.side,
    entry: i.entry,
    entryTs: i.entryTs,
    exit: { ts: last.ts + MIN, price: last.close },
    signalSl: i.sl,
    targets: [...i.targets],
    lotQty: i.lotQty * vf,
    cap: i.cap,
    tick: i.tick,
    path: { method: 'contract-1m', points: contractPathFromBars(inSession, i.entryTs) },
    judge: { reasons: [], aiSkipReason: null, riskRupees: null },
  });
  return pnlFromOutcome(fair.capOutcome, i);
}

/** A stored fair check (signal_decisions.ai_check.fair) → ₹ per lot net. Reuse only where vf = 1 (see takeOutcome). */
export function takeOutcomeFromFair(fair: FairCheck, i: Pick<EntryGradeInput, 'side' | 'entry' | 'lotQty' | 'valueFactor' | 'segment'>): TakeOutcome {
  return pnlFromOutcome(fair.capOutcome, i);
}

function pnlFromOutcome(o: StopOutcome, i: Pick<EntryGradeInput, 'side' | 'entry' | 'lotQty' | 'valueFactor' | 'segment'>): TakeOutcome {
  if (o.result === 'UNSCORABLE' || !fin(o.pnlPerUnit) || !pos(o.price)) return { pnl: null, outcome: o, reason: o.reason.startsWith('path gap') || o.reason.startsWith('no path') ? `missing bars: ${o.reason}` : o.reason };
  const vf = vfOf(i.valueFactor);
  const gross = o.pnlPerUnit * i.lotQty * vf;
  const charges = estimateCharges({ segment: i.segment, entryPrice: i.entry, exitPrice: o.price, qty: i.lotQty, side: i.side === 'SELL' ? 'SHORT' : 'LONG', valueFactor: vf });
  return { pnl: r2(gross - charges), outcome: o, reason: `${o.result.toLowerCase()} at ${o.price} (${o.reason})` };
}

/** The call was SKIPPED (or blocked): chosen = ₹0, alternative = what taking it made. */
export function gradeSkip(i: EntryGradeInput | { outcome: TakeOutcome }): Grade {
  const t = 'outcome' in i ? i.outcome : takeOutcome(i);
  if (t.pnl === null) return unscorable('close', t.reason);
  return verdictOf('close', 0, t.pnl, null, `skipped; taking it: ${t.reason}`);
}

/** The call was TAKEN: chosen = what it made, alternative = ₹0 (not taking it). */
export function gradeTake(i: EntryGradeInput | { outcome: TakeOutcome }): Grade {
  const t = 'outcome' in i ? i.outcome : takeOutcome(i);
  if (t.pnl === null) return unscorable('close', t.reason);
  return verdictOf('close', t.pnl, 0, null, `taken: ${t.reason}`);
}
