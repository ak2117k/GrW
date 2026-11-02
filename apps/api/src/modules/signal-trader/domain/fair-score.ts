import { orderedTargets } from './paper';

/**
 * FAIR scoring of the AI entry judge (owner 2026-11-02, after NIFTY 23000 CE). Pure.
 *
 * The old check (domain/ai-check `correct`) holds the judge against the LEARNING paper trade, which
 * runs with NO stop: a SKIP is "wrong" whenever a no-stop trade drifted into profit, including calls
 * the judge could never have taken inside the hard caps. The fair check replays the trade's actual
 * price path against two stops:
 *   (a) the signal's own SL (the plan's sl; none = no stop);
 *   (b) the CAP-SIZED stop: the widest stop that keeps 1 lot's risk ≤ caps.maxLossPerTrade
 *       (BUY: entry − cap / lotQty; SELL: entry + cap / lotQty), never wider than the signal's SL —
 *       the trade the judge could actually have taken.
 * Each version exits at the plan's FIRST target ahead of the entry or the stop, whichever the path
 * reaches first, else at the paper trade's actual exit. The verdict is on (b):
 *   SKIP → RIGHT when the cap-sized trade lost (stopped, or closed ≤ entry), WRONG when it made money;
 *   TAKE → RIGHT when it made money, WRONG otherwise. No judge verdict (NONE) → UNSCORABLE.
 * A path that does not cover the trade densely up to its first event is UNSCORABLE (never guessed).
 * When the stop and the target fall in the same bar, the stop is assumed first (`ambiguous`).
 */
export const FAIR_SCORE_VERSION = 'fair-v1';

/** A path sample in CONTRACT price terms: a 1-min bar (high/low) or a point (high = low). */
export interface PathPoint {
  /** A bar's START (ms), or a sample's time. */
  ts: number;
  high: number;
  low: number;
  /** ms the point covers: 60 000 for a 1-min bar, 0 (default) for a price sample. */
  span?: number;
}

export interface FairPath {
  /** 'contract-1m' | 'underlying-1m×delta' | 'paper-watch samples' … — written on the record. */
  method: string;
  points: PathPoint[];
  /** A breach of the SIGNAL stop seen by the 30 s paper-watch shadow (exit-shadow STOP row): definitive. */
  signalStopSeen?: { ts: number; price: number } | null;
  /** Free text on how the path was built (delta source, reference price, gaps). */
  note?: string;
}

export type StopResult = 'STOPPED' | 'TARGET' | 'EXIT' | 'UNSCORABLE';

export interface StopOutcome {
  stop: number | null;
  result: StopResult;
  at: string | null;
  price: number | null;
  /** side × (price − entry), per unit. */
  pnlPerUnit: number | null;
  /** ₹ for 1 lot. */
  pnl1Lot: number | null;
  ambiguous?: boolean;
  reason: string;
}

export type FairVerdict = 'RIGHT' | 'WRONG' | 'UNSCORABLE';
export type SkipKind = 'RISK_CAP' | 'JUDGEMENT';

export interface FairCheck {
  version: string;
  verdict: FairVerdict;
  /** SKIP only: was the decisive reason the cap / sizing, or a market judgement? */
  skipKind: SkipKind | null;
  capStop: number | null;
  capOutcome: StopOutcome;
  signalStop: number | null;
  signalStopOutcome: StopOutcome;
  target: number | null;
  lotQty: number;
  cap: number | null;
  method: string;
  note: string;
}

/** Points may be missing for this long without breaking coverage (the 1-min bar store drops quiet minutes). */
export const MAX_GAP_MS = 5 * 60_000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const roundTick = (p: number, tick: number) => (tick > 0 ? Math.round(p / tick) * tick : p);

/** The cap-sized stop (see the header). null when the cap is unknown or the lot cannot lose the cap (stop would be ≤ 0). */
export function capSizedStop(i: { side: string; entry: number; cap: number | null; lotQty: number; signalSl: number | null; tick?: number }): number | null {
  if (!(i.entry > 0) || !(i.lotQty > 0) || i.cap === null || !(i.cap > 0)) return null;
  const buy = String(i.side).toUpperCase() !== 'SELL';
  const dist = i.cap / i.lotQty;
  const raw = buy ? i.entry - dist : i.entry + dist;
  const sl = validStop(i.side, i.entry, i.signalSl);
  // Never wider than the signal's own SL: when that already fits the cap it IS the trade the judge could take.
  const tighter = sl === null ? raw : buy ? Math.max(raw, sl) : Math.min(raw, sl);
  if (!(tighter > 0)) return sl;
  return r2(roundTick(tighter, i.tick ?? 0.05));
}

/** A stop on the protective side of the entry, else null (0 / missing / wrong side = no stop). */
export function validStop(side: string, entry: number, sl: number | null | undefined): number | null {
  if (typeof sl !== 'number' || !Number.isFinite(sl) || !(sl > 0)) return null;
  const buy = String(side).toUpperCase() !== 'SELL';
  return buy ? (sl < entry ? sl : null) : sl > entry ? sl : null;
}

/** Replay one stop / first-target version over the path; the paper exit when neither is reached. */
export function replayStop(i: {
  side: string;
  entry: number;
  entryTs: number;
  stop: number | null;
  target: number | null;
  exit: { ts: number; price: number } | null;
  path: FairPath;
  lotQty: number;
  /** true when `stop` is at least as tight as the signal SL (a seen signal-stop breach then also hits it). */
  stopWithinSignal?: boolean;
}): StopOutcome {
  const buy = String(i.side).toUpperCase() !== 'SELL';
  const sign = buy ? 1 : -1;
  const done = (result: StopResult, ts: number | null, price: number | null, reason: string, ambiguous?: boolean): StopOutcome => {
    const ppu = price !== null ? r2(sign * (price - i.entry)) : null;
    return { stop: i.stop, result, at: ts !== null ? new Date(ts).toISOString() : null, price, pnlPerUnit: ppu, pnl1Lot: ppu !== null ? r2(ppu * i.lotQty) : null, ...(ambiguous ? { ambiguous } : {}), reason };
  };
  if (!(i.entry > 0)) return done('UNSCORABLE', null, null, 'no entry price');
  if (!i.exit) return done('UNSCORABLE', null, null, 'the paper trade has not closed');
  const end = i.exit.ts;
  const seen = i.path.signalStopSeen && i.stopWithinSignal && i.stop !== null ? i.path.signalStopSeen : null;
  // A bar counts only when it starts after the fill's minute and ends by the exit (its part after the exit never happened to this trade).
  const pts = i.path.points
    .filter((p) => (p.span ? p.ts >= i.entryTs - (i.entryTs % 60_000) + 60_000 : p.ts > i.entryTs) && p.ts + (p.span ?? 0) <= end && Number.isFinite(p.high) && Number.isFinite(p.low))
    .sort((a, b) => a.ts - b.ts);
  let last = i.entryTs;
  for (const p of pts) {
    if (seen && seen.ts <= p.ts) return done('STOPPED', seen.ts, i.stop, `the signal stop was crossed (paper-watch shadow, LTP ${seen.price}); this stop is no wider`);
    if (p.ts - last > MAX_GAP_MS) {
      return done('UNSCORABLE', null, null, `path gap ${Math.round((p.ts - last) / 60_000)} min from ${new Date(last).toISOString().slice(11, 16)} UTC before any stop / target was reached`);
    }
    last = Math.max(last, p.ts + (p.span ?? 0));
    const hitStop = i.stop !== null && (buy ? p.low <= i.stop : p.high >= i.stop);
    const hitTarget = i.target !== null && (buy ? p.high >= i.target : p.low <= i.target);
    if (hitStop) return done('STOPPED', p.ts, i.stop, hitTarget ? 'stop and target in the same bar — stop assumed first' : `stop ${i.stop} reached`, hitTarget);
    if (hitTarget) return done('TARGET', p.ts, i.target, `target ${i.target} reached`);
  }
  if (seen) return done('STOPPED', seen.ts, i.stop, `the signal stop was crossed (paper-watch shadow, LTP ${seen.price}); this stop is no wider`);
  // Nothing inside the trade (e.g. a 25-second trade inside its entry minute): the interior is unknown.
  if (pts.length === 0) return done('UNSCORABLE', null, null, 'no path point inside the trade (it lived inside its entry minute, or nothing is stored)');
  if (end - last > MAX_GAP_MS) return done('UNSCORABLE', null, null, `path ends ${Math.round((end - last) / 60_000)} min before the paper exit`);
  return done('EXIT', end, i.exit.price, 'neither stop nor target reached: the paper trade\'s own exit');
}

/**
 * SKIP kind: RISK_CAP when the plan's 1-lot risk broke the cap AND the decisive (first) reason is the
 * cap / sizing; else JUDGEMENT. A judge that never answered is not a skip kind (null). Pure.
 */
const CAP_WORDS = /\b(cap|caps|capped|max(imum)?[ -]?loss|maxlosspertrade|loss limit|risk (busts|breaks|exceeds|over|above|too)|busts|sizing|size|position size|too wide|wide stop|per[- ]trade)\b/i;
export function skipKindOf(i: { aiDecision: string; reasons: readonly string[]; aiSkipReason?: string | null; riskRupees: number | null; cap: number | null }): SkipKind | null {
  if (i.aiDecision !== 'SKIP') return null;
  if (i.aiSkipReason === 'judge_unavailable' || i.aiSkipReason === 'judge_invalid') return null;
  const overCap = i.riskRupees !== null && i.cap !== null && i.riskRupees > i.cap + 1e-9;
  const first = i.reasons.find((r) => r.trim() !== '') ?? '';
  return overCap && CAP_WORDS.test(first) ? 'RISK_CAP' : 'JUDGEMENT';
}

export function fairCheck(i: {
  aiDecision: 'TAKE' | 'SKIP' | 'NONE';
  side: string;
  entry: number | null;
  entryTs: number;
  exit: { ts: number; price: number } | null;
  signalSl: number | null;
  targets: unknown;
  lotQty: number;
  cap: number | null;
  tick?: number;
  path: FairPath | null;
  judge: { reasons: readonly string[]; aiSkipReason?: string | null; riskRupees: number | null };
}): FairCheck {
  const entry = i.entry ?? 0;
  const signalStop = validStop(i.side, entry, i.signalSl);
  const capStop = capSizedStop({ side: i.side, entry, cap: i.cap, lotQty: i.lotQty, signalSl: i.signalSl, tick: i.tick });
  const target = entry > 0 ? (orderedTargets(i.side, entry, i.targets)[0] ?? null) : null;
  const skipKind = skipKindOf({ aiDecision: i.aiDecision, reasons: i.judge.reasons, aiSkipReason: i.judge.aiSkipReason, riskRupees: i.judge.riskRupees, cap: i.cap });
  const noPath: StopOutcome = { stop: null, result: 'UNSCORABLE', at: null, price: null, pnlPerUnit: null, pnl1Lot: null, reason: 'no price path stored for the trade' };
  const path = i.path;
  const base = { version: FAIR_SCORE_VERSION, skipKind, capStop, signalStop, target, lotQty: i.lotQty, cap: i.cap, method: path?.method ?? 'none', note: path?.note ?? '' };
  if (!path) return { ...base, verdict: 'UNSCORABLE', capOutcome: { ...noPath, stop: capStop }, signalStopOutcome: { ...noPath, stop: signalStop } };
  const run = (stop: number | null, within: boolean) => replayStop({ side: i.side, entry, entryTs: i.entryTs, stop, target, exit: i.exit, path, lotQty: i.lotQty, stopWithinSignal: within });
  const signalStopOutcome = run(signalStop, true);
  const capWithin = capStop !== null && (signalStop === null ? false : String(i.side).toUpperCase() !== 'SELL' ? capStop >= signalStop : capStop <= signalStop);
  const capOutcome = capStop === null ? { ...signalStopOutcome, stop: null, reason: `no cap-sized stop (${i.cap === null ? 'cap unknown' : 'a lot cannot lose the cap'}): ${signalStopOutcome.reason}` } : run(capStop, capWithin);
  let verdict: FairVerdict = 'UNSCORABLE';
  if (i.aiDecision !== 'NONE' && capOutcome.result !== 'UNSCORABLE' && capOutcome.pnlPerUnit !== null) {
    const won = capOutcome.pnlPerUnit > 0;
    verdict = (i.aiDecision === 'TAKE' ? won : !won) ? 'RIGHT' : 'WRONG';
  }
  return { ...base, verdict, capOutcome, signalStopOutcome };
}

/**
 * The underlying's 1-min bars → a CONTRACT path by a linear delta: premium ≈ entry + Δ·(u − u0) for a
 * CE / long-delta contract, entry − |Δ|·(u − u0) for a PE (its low comes from the underlying's high).
 * u0 = the underlying at entry (the close of the 1-min bar holding the entry). The entry minute itself
 * is not replayed (its part before the fill is unknown). Gamma / theta are ignored: say so on the record.
 */
export function contractPathFromUnderlying(i: { bars: ReadonlyArray<{ ts: number; high: number; low: number; close: number }>; entry: number; entryTs: number; kind: string; absDelta: number }): { points: PathPoint[]; u0: number | null } {
  const bars = [...i.bars].filter((b) => [b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0)).sort((a, b) => a.ts - b.ts);
  const entryMin = Math.floor(i.entryTs / 60_000) * 60_000;
  const at = bars.filter((b) => b.ts <= entryMin).pop();
  const u0 = at && entryMin - at.ts <= MAX_GAP_MS ? at.close : null;
  if (u0 === null) return { points: [], u0: null };
  const put = i.kind === 'PE';
  const d = Math.abs(i.absDelta);
  const px = (u: number) => (put ? i.entry - d * (u - u0) : i.entry + d * (u - u0));
  const points = bars
    .filter((b) => b.ts > entryMin)
    .map((b) => ({ ts: b.ts, high: r2(Math.max(px(b.high), px(b.low))), low: r2(Math.min(px(b.high), px(b.low))), span: 60_000 }));
  return { points, u0 };
}

/** True when the points cover [entryTs, endTs] with no gap over {@link MAX_GAP_MS} (the replay's own rule). */
export function denseCover(points: readonly PathPoint[], entryTs: number, endTs: number): boolean {
  const pts = points.filter((p) => p.ts + (p.span ?? 0) <= endTs).sort((a, b) => a.ts - b.ts);
  if (pts.length === 0) return false;
  let last = entryTs;
  for (const p of pts) {
    if (p.ts < entryTs) continue;
    if (p.ts - last > MAX_GAP_MS) return false;
    last = Math.max(last, p.ts + (p.span ?? 0));
  }
  return endTs - last <= MAX_GAP_MS;
}

/** The contract's own 1-min bars → path points (the entry minute dropped, as above). */
export function contractPathFromBars(bars: ReadonlyArray<{ ts: number; high: number; low: number }>, entryTs: number): PathPoint[] {
  const entryMin = Math.floor(entryTs / 60_000) * 60_000;
  return bars.filter((b) => b.ts > entryMin && Number.isFinite(b.high) && Number.isFinite(b.low) && b.low > 0).map((b) => ({ ts: b.ts, high: b.high, low: b.low, span: 60_000 }));
}
