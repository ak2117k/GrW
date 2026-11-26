import { istYmd } from '../../mbm/domain/chain-snapshot';
import { BAR_15M_MS, type Bar15m } from '../../ai-setups/domain/setup-watch';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import type { Proposal } from './desk.types';

/**
 * Nightly grade of one desk-manager decision (plan 2026-11-26 Task 6, spec §5.8). Pure.
 *
 * - OPEN: the trade it opened — P&L net of charges, MFE / MAE on the underlying from 15m bars between entry and
 *   exit, and whether the manager's own stop or first target was hit first.
 * - EXIT / BOOK: the underlying 60 min after the exit vs at the exit, signed for the position. `vsHold60` > 0 means
 *   the exit SAVED points (holding would have lost them); < 0 means holding would have made more.
 * - NO_ACTION on a proposal with concrete levels: what the proposal's own entry / SL / target would have done on
 *   15m bars over the rest of its session (`hit` only, no ₹).
 * - PAUSE: the automatic entries the guard blocked while the pause was in force.
 * - Anything else: OTHER, recorded with nothing to measure.
 *
 * `gradeDecision` returns null when the decision is NOT READY yet (trade still open, the 60-min window or the
 * session not over, a pending entry still waiting): the row keeps `grade = null` and the next nightly run retries
 * it. Missing bars never throw: the grade is written with the bar-based fields null and the reason in `note`.
 *
 * Bar rules (15m is the smallest unit): a bar is used only once closed (ts + 15 min ≤ now). The bar an event falls
 * in counts by its CLOSE only for the start (its range may predate the event) and by its OPEN only for the end (its
 * range may postdate it); bars fully inside count by their whole range, walked adverse extreme first.
 * Prices are "the close of the 15m bar containing t" — 15m resolution, never 1m.
 */

export const DESK_GRADE_VERSION = 1;
const HOLD_WINDOW_MS = 60 * 60_000;

export type DeskGradeKind = 'OPEN' | 'NO_ACTION' | 'EXIT' | 'PAUSE' | 'OTHER';
export type DeskGradeHit = 'TARGET' | 'STOP' | 'NEITHER';

/** desk_manager_decisions.grade (Task 3's scorecard reads it). */
export interface DeskGrade {
  kind: DeskGradeKind;
  /** Gross ₹ of the trade (OPEN; EXIT / BOOK: the closed tracker's). */
  pnl: number | null;
  /** pnl − charges (OPEN; EXIT / BOOK). */
  netPnl: number | null;
  hit: DeskGradeHit | null;
  /** Best move in the position's favour on the underlying, points (≥ 0). */
  mfe: number | null;
  /** Worst move against the position on the underlying, points (≥ 0, a magnitude). */
  mae: number | null;
  /** EXIT / BOOK: underlying points the exit saved vs holding 60 min (> 0 = the exit was right). */
  vsHold60: number | null;
  note: string;
  /** PAUSE: automatic entries blocked by the pause while it was in force. */
  blocked?: number;
  version: number;
  at: string;
}

/** One desk_manager_decisions row as the grader reads it. */
export interface GradeDecisionRow {
  id: string;
  userId: string;
  runId: string;
  action: string;
  status: string;
  underlying: string | null;
  trackerId: string | null;
  payload: unknown;
  createdAt: Date;
}

/** The trade an OPEN opened, or the position an EXIT / BOOK closed. */
export interface GradeTrade {
  id: string;
  /** OPEN | CLOSED | … as stored. */
  status: string;
  symbol: string | null;
  entryAt: Date | null;
  exitAt: Date | null;
  pnl: number | null;
  /** Round-trip charges in ₹; null when not known. */
  charges: number | null;
}

export interface GradeInput {
  row: GradeDecisionRow;
  now: Date;
  /** OPEN: the trade it opened; EXIT / BOOK: the position it closed. */
  trade?: GradeTrade | null;
  /** OPEN with a ZONE / BREAKOUT entry: desk_manager_pending_entries.status (null = no pending row). */
  pendingStatus?: string | null;
  /** The decision's underlying (EXIT rows may carry it only on the OPEN). */
  underlying?: string | null;
  /** The underlying's 15m bars over `barsWindow` (null = not read: see barsError). */
  bars?: readonly Bar15m[] | null;
  barsError?: string | null;
  /** NO_ACTION: the proposal it passed on (from the run's packet). */
  proposal?: Proposal | null;
  /** PAUSE: blocked desk_guard_events of the user inside the pause window. */
  guardEvents?: ReadonlyArray<{ at: Date; reasons: unknown }> | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const istHm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
const NOT_EXECUTED = new Set(['INVALID', 'REFUSED', 'FAILED']);

/** The grade kind of an action. */
export function gradeKindOf(action: string): DeskGradeKind {
  if (action === 'OPEN') return 'OPEN';
  if (action === 'EXIT' || action === 'BOOK') return 'EXIT';
  if (action === 'NO_ACTION') return 'NO_ACTION';
  if (action === 'PAUSE_ENTRIES') return 'PAUSE';
  return 'OTHER';
}

/** The IST session end of `underlying` on the IST day of `at` (MCX 23:30, else 15:30). */
export function sessionEnd(underlying: string, at: Date): Date {
  const mcx = segmentFor({ underlying, instrumentKind: 'FUT' }) === 'MCX';
  return new Date(`${istYmd(at)}T${mcx ? '23:30' : '15:30'}:00+05:30`);
}

/** +1 when the position gains as the underlying rises (CE / FUT), −1 for PE; null when unreadable. */
export function directionOf(sideOrSymbol: unknown): 1 | -1 | null {
  const s = String(sideOrSymbol ?? '').trim().toUpperCase();
  if (!s) return null;
  if (/(^|_)PE$|\dPE$/.test(s) || s === 'PE' || s === 'SELL' || s === 'SHORT' || s === 'BEAR' || s === 'BEARISH') return -1;
  if (/(^|_)(CE|FUT)$|\d(CE|FUT)$/.test(s) || s === 'CE' || s === 'FUT' || s === 'BUY' || s === 'LONG' || s === 'BULL' || s === 'BULLISH') return 1;
  return null;
}

/** The [from, to] window of 15m bars the grade needs (null = no bars needed / not ready to say). */
export function barsWindow(i: Pick<GradeInput, 'row' | 'trade' | 'underlying'>): { from: Date; to: Date } | null {
  const kind = gradeKindOf(i.row.action);
  if (kind === 'OPEN') {
    if (!i.trade?.entryAt || !i.trade.exitAt) return null;
    return { from: i.trade.entryAt, to: new Date(i.trade.exitAt.getTime() + BAR_15M_MS) };
  }
  if (kind === 'EXIT') {
    if (!i.trade?.exitAt) return null;
    return { from: i.trade.exitAt, to: new Date(i.trade.exitAt.getTime() + HOLD_WINDOW_MS + BAR_15M_MS) };
  }
  if (kind === 'NO_ACTION') {
    const u = i.underlying ?? i.row.underlying;
    if (!u) return null;
    return { from: i.row.createdAt, to: sessionEnd(u, i.row.createdAt) };
  }
  return null;
}

/** Closed bars keyed by their slot start. */
function closedBars(bars: readonly Bar15m[] | null | undefined, now: Date): Map<number, Bar15m> {
  const out = new Map<number, Bar15m>();
  for (const b of bars ?? []) {
    if (![b.ts, b.open, b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (b.ts + BAR_15M_MS <= now.getTime()) out.set(b.ts, b);
  }
  return out;
}

const slotOf = (ms: number) => Math.floor(ms / BAR_15M_MS) * BAR_15M_MS;

/**
 * The underlying's price path from `from` to `to` at 15m resolution: the start bar by its close, middle bars
 * open → adverse → favourable → close, the end bar by its open. Null (with why) when the start bar is missing.
 * Slots with no bar (session breaks, gaps) are skipped.
 */
function pricePath(byTs: Map<number, Bar15m>, from: number, to: number, dir: 1 | -1): { ok: true; ref: number; path: number[]; gaps: number } | { ok: false; reason: string } {
  const s0 = slotOf(from);
  const first = byTs.get(s0);
  if (!first) return { ok: false, reason: `no closed 15m bar at ${istYmd(new Date(s0))} ${istHm(s0)} IST` };
  const sEnd = slotOf(to);
  const path: number[] = [first.close];
  let gaps = 0;
  for (let s = s0 + BAR_15M_MS; s <= sEnd; s += BAR_15M_MS) {
    const b = byTs.get(s);
    if (!b) {
      gaps++;
      continue;
    }
    if (s === sEnd) {
      path.push(b.open);
      break;
    }
    if (dir === 1) path.push(b.open, b.low, b.high, b.close);
    else path.push(b.open, b.high, b.low, b.close);
  }
  return { ok: true, ref: first.close, path, gaps };
}

/** The close of the closed 15m bar containing `t`; null when it is missing. */
function priceAt(byTs: Map<number, Bar15m>, t: number): number | null {
  return byTs.get(slotOf(t))?.close ?? null;
}

/** Which of stop / target the path touches first. */
function firstHit(path: readonly number[], dir: 1 | -1, stop: number | null, target: number | null): DeskGradeHit | null {
  if (stop === null || target === null) return null;
  for (const px of path) {
    if (dir === 1 ? px <= stop : px >= stop) return 'STOP';
    if (dir === 1 ? px >= target : px <= target) return 'TARGET';
  }
  return 'NEITHER';
}

const base = (kind: DeskGradeKind, now: Date, note: string): DeskGrade => ({
  kind, pnl: null, netPnl: null, hit: null, mfe: null, mae: null, vsHold60: null, note, version: DESK_GRADE_VERSION, at: now.toISOString(),
});

const barsWhy = (i: GradeInput) => `15m bars unavailable: ${i.barsError ?? 'not read'}`;

function gradeOpen(i: GradeInput): DeskGrade | null {
  const { row, now } = i;
  if (NOT_EXECUTED.has(row.status)) return base('OPEN', now, `not executed (${row.status})`);
  if (i.pendingStatus === 'PENDING') return null;
  const t = i.trade;
  if (!t) {
    if (i.pendingStatus) return base('OPEN', now, `pending entry ${i.pendingStatus} — never filled`);
    if (row.status === 'PENDING') return null;
    return base('OPEN', now, `no trade linked to the decision (status ${row.status})`);
  }
  if (t.status !== 'CLOSED' || !t.exitAt || t.pnl === null) return null;
  const pnl = r2(t.pnl);
  const netPnl = t.charges === null ? null : r2(t.pnl - t.charges);
  const notes: string[] = [`trade ${t.id} closed ${istYmd(t.exitAt)} ${istHm(t.exitAt.getTime())} IST, gross ₹${pnl}`];
  if (netPnl === null) notes.push('charges unknown: net ₹ not computed');
  else notes.push(`net ₹${netPnl}`);
  const g: DeskGrade = { ...base('OPEN', now, ''), pnl, netPnl };
  const p = isRec(row.payload) ? row.payload : {};
  const dir = directionOf(p.side) ?? directionOf(t.symbol);
  const entryAt = t.entryAt ?? row.createdAt;
  if (dir === null) notes.push('direction unreadable: no MFE / MAE');
  else if (!i.bars) notes.push(barsWhy(i));
  else {
    const pp = pricePath(closedBars(i.bars, now), entryAt.getTime(), t.exitAt.getTime(), dir);
    if (!pp.ok) notes.push(`no MFE / MAE: ${pp.reason}`);
    else {
      const moves = pp.path.map((px) => dir * (px - pp.ref));
      g.mfe = r2(Math.max(0, ...moves));
      g.mae = r2(Math.max(0, ...moves.map((m) => -m)));
      const stop = num(isRec(p.stop) ? p.stop.underlying : null);
      const targets = isRec(p.targets) && Array.isArray(p.targets.underlying) ? p.targets.underlying : [];
      const t1 = num(targets[0]);
      g.hit = firstHit(pp.path, dir, stop, t1);
      notes.push(`underlying ref ${pp.ref} (entry bar close); stop ${stop ?? '—'}, T1 ${t1 ?? '—'}${g.hit === null ? ' — hit not graded (stop / target missing)' : ''}${pp.gaps ? `; ${pp.gaps} 15m slot(s) without a bar` : ''}`);
    }
  }
  g.note = notes.join('; ');
  return g;
}

function gradeExit(i: GradeInput): DeskGrade | null {
  const { row, now } = i;
  if (row.status !== 'DONE') return base('EXIT', now, `not executed (${row.status})`);
  const t = i.trade;
  if (!t) return base('EXIT', now, `position ${row.trackerId ?? '—'} not found`);
  if (t.status !== 'CLOSED' || !t.exitAt) return null;
  const exitMs = t.exitAt.getTime();
  // Both the exit bar and the bar 60 min later must have closed.
  if (now.getTime() < slotOf(exitMs + HOLD_WINDOW_MS) + BAR_15M_MS) return null;
  const g: DeskGrade = { ...base('EXIT', now, ''), pnl: t.pnl === null ? null : r2(t.pnl), netPnl: t.pnl === null || t.charges === null ? null : r2(t.pnl - t.charges) };
  const dir = directionOf(t.symbol) ?? directionOf(isRec(row.payload) ? row.payload.side : null);
  const at = `exit ${istHm(exitMs)} IST`;
  if (dir === null) g.note = `${at}; direction unreadable from ${t.symbol ?? '—'}: vsHold60 not graded`;
  else if (!i.underlying) g.note = `${at}; underlying unknown: vsHold60 not graded`;
  else if (!i.bars) g.note = `${at}; ${barsWhy(i)}`;
  else {
    const byTs = closedBars(i.bars, now);
    const px0 = priceAt(byTs, exitMs);
    const px60 = priceAt(byTs, exitMs + HOLD_WINDOW_MS);
    if (px0 === null || px60 === null) g.note = `${at}; no closed 15m bar at ${px0 === null ? 'the exit' : 'exit + 60 min'}: vsHold60 not graded`;
    else {
      g.vsHold60 = r2(dir * (px0 - px60));
      g.note = `${at}; ${i.underlying} ${px0} at exit, ${px60} 60 min later; ${g.vsHold60 > 0 ? 'exit saved' : g.vsHold60 < 0 ? 'holding would have made' : 'no difference,'} ${Math.abs(g.vsHold60)} pts`;
    }
  }
  return g;
}

/** A proposal's own levels, read tolerantly from its detail (top level, `.call`, or `.setup`). */
export function proposalLevels(p: Proposal): { dir: 1 | -1 | null; entryLow: number | null; entryHigh: number | null; stop: number | null; target: number | null } | null {
  const srcs = [p.detail, isRec(p.detail) ? p.detail.call : null, isRec(p.detail) ? p.detail.setup : null].filter(isRec);
  const pick = (keys: string[]): unknown => {
    for (const s of srcs) for (const k of keys) if (s[k] !== undefined && s[k] !== null) return s[k];
    return undefined;
  };
  const first = (v: unknown) => (Array.isArray(v) ? num(v[0]) : num(v));
  const stop = first(pick(['sl', 'stop', 'stopLoss', 'stoploss']));
  const target = first(pick(['targets', 'target', 'tgt']));
  const e = pick(['entry', 'entryPrice', 'level', 'trigger']);
  let entryLow: number | null = null;
  let entryHigh: number | null = null;
  if (isRec(e)) {
    entryLow = num(e.low) ?? num(e.level) ?? num(e.price) ?? num(e.trigger);
    entryHigh = num(e.high) ?? entryLow;
  } else {
    entryLow = first(e);
    entryHigh = entryLow;
  }
  if (stop === null || target === null) return null;
  const d = pick(['side', 'direction', 'bias', 'optionType', 'instrumentKind']);
  const dir = directionOf(d) ?? (target > stop ? 1 : target < stop ? -1 : null);
  return { dir, entryLow, entryHigh, stop, target };
}

function gradeNoAction(i: GradeInput): DeskGrade | null {
  const { row, now } = i;
  const p = i.proposal;
  if (!p) return base('NO_ACTION', now, 'no proposal referenced: nothing to grade');
  const lv = proposalLevels(p);
  if (!lv || lv.dir === null) return base('NO_ACTION', now, `proposal ${p.ref} has no concrete SL / target: nothing to grade`);
  const u = i.underlying ?? row.underlying ?? p.underlying;
  if (!u) return base('NO_ACTION', now, `proposal ${p.ref}: underlying unknown`);
  const end = sessionEnd(u, row.createdAt).getTime();
  if (now.getTime() < end) return null;
  if (!i.bars) return base('NO_ACTION', now, `proposal ${p.ref}: ${barsWhy(i)}`);
  const pp = pricePath(closedBars(i.bars, now), row.createdAt.getTime(), end, lv.dir);
  if (!pp.ok) return base('NO_ACTION', now, `proposal ${p.ref}: ${pp.reason}`);
  let path = pp.path;
  const hasEntry = lv.entryLow !== null && lv.entryHigh !== null;
  if (hasEntry) {
    const lo = Math.min(lv.entryLow!, lv.entryHigh!);
    const hi = Math.max(lv.entryLow!, lv.entryHigh!);
    let prev: number | null = null;
    const at = path.findIndex((px) => {
      const hitNow = (px >= lo && px <= hi) || (prev !== null && ((prev < lo && px > hi) || (prev > hi && px < lo)));
      prev = px;
      return hitNow;
    });
    if (at < 0) {
      return { ...base('NO_ACTION', now, `proposal ${p.ref}: entry ${lo === hi ? lo : `${lo}–${hi}`} never reached before ${istHm(end)} IST`), hit: 'NEITHER' };
    }
    path = path.slice(at);
  }
  const hit = firstHit(path, lv.dir, lv.stop, lv.target);
  return {
    ...base('NO_ACTION', now, `proposal ${p.ref} (${lv.dir === 1 ? 'long' : 'short'} underlying): ${hasEntry ? 'entry reached' : `entry at ${pp.ref}`}, SL ${lv.stop}, T1 ${lv.target} → ${hit}`),
    hit,
  };
}

function gradePause(i: GradeInput): DeskGrade | null {
  const { row, now } = i;
  if (NOT_EXECUTED.has(row.status)) return base('PAUSE', now, `not executed (${row.status})`);
  const minutes = num(isRec(row.payload) ? row.payload.minutes : null);
  if (minutes === null || !(minutes > 0)) return base('PAUSE', now, 'pause minutes unreadable');
  const from = row.createdAt.getTime();
  const end = from + minutes * 60_000;
  if (now.getTime() < end) return null;
  const evs = (i.guardEvents ?? []).filter((e) => e.at.getTime() >= from && e.at.getTime() < end);
  const byPause = evs.filter((e) => /paus/i.test(JSON.stringify(e.reasons ?? ''))).length;
  const scope = isRec(row.payload) ? String(row.payload.scope ?? 'all') : 'all';
  return {
    ...base('PAUSE', now, `pause ${scope} ${istHm(from)}–${istHm(end)} IST blocked ${byPause} automatic entr${byPause === 1 ? 'y' : 'ies'}${evs.length > byPause ? ` (${evs.length} blocked in all by the guard)` : ''}`),
    blocked: byPause,
  };
}

/** The decision's grade, or null when it is not ready yet (the next nightly run retries it). Never throws on data. */
export function gradeDecision(i: GradeInput): DeskGrade | null {
  switch (gradeKindOf(i.row.action)) {
    case 'OPEN':
      return gradeOpen(i);
    case 'EXIT':
      return gradeExit(i);
    case 'NO_ACTION':
      return gradeNoAction(i);
    case 'PAUSE':
      return gradePause(i);
    default:
      return base('OTHER', i.now, `${i.row.action} (${i.row.status}): nothing to measure`);
  }
}
