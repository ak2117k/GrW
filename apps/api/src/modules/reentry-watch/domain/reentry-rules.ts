import { noiseFromBars } from '../../exit-discipline/noise';
import type { MinuteBar } from '../../exit-discipline/types';
import { ENTRY_ENGINE, type Bar1m, type ComponentLean, type Direction, type OiReading, type TrendReading } from '../../entry-engine/domain/entry-decision';

/**
 * RE-ENTRY WATCH rules (docs/superpowers/specs/2026-11-05-reentry-watch-design.md). Pure, deterministic.
 * After an option position is exited, the underlying is watched for the rest of its session: a move back
 * in the original direction (≥ 1 N15 beyond the exit point, trend agreeing) is a SAME-direction re-entry;
 * a move against it (≥ 2 N15, trend flipped, OI not against) is an OPPOSITE-direction re-entry.
 */
export const REENTRY_WATCH = Object.freeze({
  /** Minutes after the exit (or after a re-entry's own exit) before the watch may signal. */
  cooldownMin: 10,
  maxPerOriginal: 2,
  maxPerDay: 3,
  /** SAME: the underlying back beyond the exit point by ≥ this many N15. */
  sameN: 1,
  /** OPPOSITE: the underlying against the original direction by ≥ this many N15. */
  oppositeN: 2,
  /** No signal in the session's last minutes (the entry engine's rule). */
  noEntryLastMin: ENTRY_ENGINE.noEntryLastMin,
  noiseBucketMin: 15,
  atrPeriod: 14,
});

/** The engine universe the watch can read (index line or MCX nearest future + chain + liquidity). */
export const REENTRY_UNIVERSE: readonly string[] = Object.freeze(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD', 'SILVER']);

const MIN = 60_000;
const IST = 330 * MIN;
const r2 = (n: number) => Math.round(n * 100) / 100;
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

export type ExitOrigin = 'REAL' | 'SIGNAL_PAPER' | 'ENGINE_PAPER';

/** One exited option position, from trade_trackers (REAL) or trades (paper). */
export interface ExitedPosition {
  refTable: 'trade_trackers' | 'trades';
  refId: string;
  origin: ExitOrigin;
  symbol: string;
  exchange: string;
  /** Instrument name (resolved by tradingsymbol + exchange), upper case; null when unknown. */
  underlying: string | null;
  kind: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  entryAt: Date | null;
  exitAt: Date;
  exitPrice: number | null;
}

export const watchKey = (p: Pick<ExitedPosition, 'refTable' | 'refId'>): string => `${p.refTable}:${p.refId}`;

/** The direction the UNDERLYING had to move for the position: long CE / short PE = BULLISH. */
export function directionOf(kind: 'CE' | 'PE', side: 'BUY' | 'SELL'): Direction {
  return (kind === 'CE') === (side === 'BUY') ? 'BULLISH' : 'BEARISH';
}

export const oppositeOf = (d: Direction): Direction => (d === 'BULLISH' ? 'BEARISH' : 'BULLISH');
export const kindFor = (d: Direction): 'CE' | 'PE' => (d === 'BULLISH' ? 'CE' : 'PE');

/** Option kind from a tradingsymbol (`…24400CE`); null for anything else. */
export function optionKindOf(symbol: string): 'CE' | 'PE' | null {
  const m = /\d(CE|PE)$/.exec(String(symbol ?? '').trim().toUpperCase());
  return m ? (m[1] as 'CE' | 'PE') : null;
}

/** The name part of an option / future tradingsymbol (`NIFTY09NOV2624400CE` → NIFTY); null when not one. */
export function nameFromSymbol(symbol: string): string | null {
  const m = /^([A-Z&-]+?)\d{2}[A-Z]{3}\d{2}/.exec(String(symbol ?? '').trim().toUpperCase());
  return m ? m[1] : null;
}

const okBar = (b: Bar1m) => [b.ts, b.high, b.low, b.close].every((x) => Number.isFinite(x)) && b.low > 0 && b.high >= b.low && b.close > 0;

/** The underlying's close of the last 1-minute bar starting at or before `at` (same IST day); null if none. */
export function underlyingAt(bars: readonly Bar1m[], at: Date): number | null {
  const t = at.getTime();
  let best: Bar1m | null = null;
  for (const b of bars) if (okBar(b) && b.ts <= t && istDay(b.ts) === istDay(t) && (!best || b.ts > best.ts)) best = b;
  return best ? best.close : null;
}

/** The position's best underlying point between entry and exit (high for BULLISH, low for BEARISH). Context only. */
export function bestUnderlying(bars: readonly Bar1m[], entryAt: Date | null, exitAt: Date, dir: Direction): number | null {
  if (!entryAt) return null;
  const xs = bars.filter((b) => okBar(b) && b.ts >= entryAt.getTime() - MIN && b.ts <= exitAt.getTime());
  if (xs.length === 0) return null;
  return dir === 'BULLISH' ? Math.max(...xs.map((b) => b.high)) : Math.min(...xs.map((b) => b.low));
}

/** IST minutes after midnight of a bar's start. */
const istMinuteOf = (ms: number) => {
  const d = new Date(ms + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** The venue's trading minutes (IST) whose bars are noise: [fromMin, toMin). */
export interface SessionMinutes {
  fromMin: number;
  toMin: number;
}

/**
 * The bars N15 reads (prod 2026-11-05: candles_1m holds NSE PRE-OPEN index bars 09:00–09:14 — the 09:00 bar
 * spanned 23,608–24,580 — and flat post-close bars; the pre-open bucket alone tripled NIFTY's N15 to ~105).
 * NSE / NFO / BSE / BFO 09:15–15:30, MCX 09:00–23:55 (the late close; bars after the real close are rare).
 */
export function noiseSessionOf(optionExchange: string): SessionMinutes {
  return String(optionExchange).toUpperCase() === 'MCX' ? { fromMin: 9 * 60, toMin: 23 * 60 + 55 } : { fromMin: 9 * 60 + 15, toMin: 15 * 60 + 30 };
}

export interface NoiseUnit {
  n: number;
  method: string;
  buckets: number;
}

/**
 * N15: ATR14 of 15-minute buckets (epoch-aligned = IST :00/:15/:30/:45) of the closed 1-minute bars, the true
 * range spanning a bucket boundary only within one IST day (the overnight gap is not noise). Fewer than 14
 * buckets ⇒ exit-discipline noiseFromBars on today's 1-minute bars × √15. null when neither can be read.
 */
export function noise15(bars: readonly Bar1m[], at: Date, session?: SessionMinutes): NoiseUnit | null {
  const t = at.getTime();
  const w = REENTRY_WATCH.noiseBucketMin * MIN;
  const inSession = (b: Bar1m) => {
    if (!session) return true;
    const m = istMinuteOf(b.ts);
    return m >= session.fromMin && m < session.toMin;
  };
  const closed = bars.filter((b) => okBar(b) && b.ts + MIN <= t && inSession(b)).sort((a, b) => a.ts - b.ts);
  const buckets: Array<{ k: number; high: number; low: number; close: number }> = [];
  for (const b of closed) {
    const k = Math.floor(b.ts / w) * w;
    const cur = buckets[buckets.length - 1];
    if (!cur || cur.k !== k) buckets.push({ k, high: b.high, low: b.low, close: b.close });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  const full = buckets.filter((x) => x.k + w <= t);
  const p = REENTRY_WATCH.atrPeriod;
  if (full.length >= p) {
    const tr = full.map((x, i) => {
      const prev = full[i - 1];
      if (!prev || istDay(prev.k) !== istDay(x.k)) return x.high - x.low;
      return Math.max(x.high - x.low, Math.abs(x.high - prev.close), Math.abs(x.low - prev.close));
    });
    const n = tr.slice(-p).reduce((s, x) => s + x, 0) / p;
    if (n > 0) return { n: r2(n), method: 'atr14-15m', buckets: full.length };
  }
  const today = closed.filter((b) => istDay(b.ts) === istDay(t));
  const one = noiseFromBars(today as MinuteBar[]);
  return one ? { n: r2(one.n * Math.sqrt(REENTRY_WATCH.noiseBucketMin)), method: `${one.method} × √15`, buckets: full.length } : null;
}

/** (price − ref) / N, signed in `dir`'s favour; null when unreadable. */
export function moveInN(dir: Direction, ref: number | null, price: number | null, n: number | null): number | null {
  if (ref === null || price === null || n === null || !(ref > 0) || !(price > 0) || !(n > 0)) return null;
  return r2(((price - ref) / n) * (dir === 'BULLISH' ? 1 : -1));
}

export interface ReentryFacts {
  at: Date;
  /** The original exit time. */
  exitAt: Date;
  /** The latest exit of a re-entry of this watch (the cooldown restarts from it); null when none. */
  lastReentryExitAt: Date | null;
  inUniverse: boolean;
  /** The underlying's venue is open now (SessionClock). */
  sessionOpen: boolean;
  minutesToClose: number | null;
  /** Underlying price at the exit minute. */
  ref: number | null;
  /** The underlying's price now (the trend's last closed bar). */
  price: number | null;
  noise: NoiseUnit | null;
  trend: Pick<TrendReading, 'lean' | 'summary'>;
  /** The OI check asked for the OPPOSITE direction; null = not read / no data. */
  oi: Pick<OiReading, 'verdict' | 'want' | 'summary'> | null;
  reentriesForOriginal: number;
  reentriesToday: number;
  /** Open positions on this underlying: real trackers + REENTRY_WATCH paper trades. */
  openOnUnderlying: number;
}

export type ReentryAction = 'SIGNAL' | 'WAIT' | 'SKIP' | 'CAP' | 'ENDED';

export interface ReentryVerdict {
  action: ReentryAction;
  /** SAME / OPPOSITE for a SIGNAL. */
  direction: 'SAME' | 'OPPOSITE' | null;
  /** The direction of the re-entry (the option to buy is kindFor(enter)). */
  enter: Direction | null;
  /** A short stable outcome key; a watch's row is written only when it changes. */
  category: string;
  move: number | null;
  reasons: string[];
}

const leanWord = (l: ComponentLean) => l.toLowerCase();

/** One watch at `f.at`. The order is the spec's: window, caps, open position, session end, data, SAME, OPPOSITE. */
export function decideReentry(original: Direction, f: ReentryFacts): ReentryVerdict {
  const v = (action: ReentryAction, category: string, reasons: string[], move: number | null = null, extra: Partial<ReentryVerdict> = {}): ReentryVerdict => ({
    action, direction: null, enter: null, category, move, reasons, ...extra,
  });
  if (!f.inUniverse) return v('SKIP', 'not-in-universe', ['skip: the underlying is not in the re-entry universe (no line / chain read)']);
  if (istDay(f.at.getTime()) !== istDay(f.exitAt.getTime())) return v('ENDED', 'ended', ['ended: the exit was on an earlier session']);
  if (!f.sessionOpen) return v('ENDED', 'ended', ['ended: the underlying\'s session is closed']);
  if (f.reentriesForOriginal >= REENTRY_WATCH.maxPerOriginal) return v('CAP', 'cap-original', [`cap: ${f.reentriesForOriginal} re-entries of this trade already (max ${REENTRY_WATCH.maxPerOriginal}) — watch done`]);
  if (f.reentriesToday >= REENTRY_WATCH.maxPerDay) return v('CAP', 'cap-day', [`cap: ${f.reentriesToday} re-entries today (max ${REENTRY_WATCH.maxPerDay})`]);
  const since = Math.max(f.exitAt.getTime(), f.lastReentryExitAt?.getTime() ?? 0);
  const waited = (f.at.getTime() - since) / MIN;
  if (waited < REENTRY_WATCH.cooldownMin) return v('WAIT', 'cooldown', [`cooldown: ${Math.floor(waited)} min since the exit (${REENTRY_WATCH.cooldownMin} min)`]);
  if (f.openOnUnderlying > 0) return v('WAIT', 'position-open', [`wait: ${f.openOnUnderlying} position(s) already open on this underlying`]);
  if (f.minutesToClose === null) return v('WAIT', 'session-unreadable', ['wait: minutes to close unreadable']);
  if (f.minutesToClose < REENTRY_WATCH.noEntryLastMin) return v('WAIT', 'session-end', [`wait: ${f.minutesToClose} min to close (no re-entry in the last ${REENTRY_WATCH.noEntryLastMin})`]);
  const n = f.noise?.n ?? null;
  const move = moveInN(original, f.ref, f.price, n);
  if (move === null) {
    const what = f.ref === null ? 'the underlying at the exit' : f.price === null ? 'the underlying price now' : 'the N15 noise unit';
    return v('WAIT', 'no-data', [`no data: ${what} could not be read`, `trend: ${f.trend.summary}`]);
  }
  const base = [`move: ${move} N15 in the original ${leanWord(original)} direction (ref ${f.ref}, now ${f.price}, N15 ${n} ${f.noise?.method ?? ''})`.trim(), `trend: ${f.trend.summary}`];
  const opp = oppositeOf(original);
  if (move >= REENTRY_WATCH.sameN) {
    if (f.trend.lean === original) return v('SIGNAL', 'signal-same', [`SAME: back ${move} N15 beyond the exit point with the trend ${leanWord(original)}`, ...base], move, { direction: 'SAME', enter: original });
    return v('WAIT', 'same-trend', [`wait: ${move} N15 beyond the exit point but the trend is ${leanWord(f.trend.lean)}, not ${leanWord(original)}`, ...base], move);
  }
  if (move <= -REENTRY_WATCH.oppositeN) {
    if (f.trend.lean !== opp) return v('WAIT', 'opposite-trend', [`wait: ${-move} N15 against the trade but the trend is ${leanWord(f.trend.lean)}, not ${leanWord(opp)}`, ...base], move);
    if (f.oi && f.oi.verdict === 'AGAINST') return v('WAIT', 'opposite-oi', [`wait: ${-move} N15 against with the trend ${leanWord(opp)}, but OI disagrees (${f.oi.summary})`, ...base], move);
    const oiWord = f.oi ? `OI ${f.oi.verdict.toLowerCase()}` : 'OI not read';
    return v('SIGNAL', 'signal-opposite', [`OPPOSITE: ${-move} N15 against the trade, the trend flipped ${leanWord(opp)}, ${oiWord}`, ...base], move, { direction: 'OPPOSITE', enter: opp });
  }
  return v('WAIT', 'no-move', [`wait: ${move} N15 from the exit point (SAME needs +${REENTRY_WATCH.sameN}, OPPOSITE −${REENTRY_WATCH.oppositeN})`, ...base], move);
}

const fmt = (x: number | null) => (x === null ? '?' : x.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const hhmm = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(11, 16);

/** The owner's Telegram line for a SIGNAL. */
export function alertText(i: {
  underlying: string;
  original: Direction;
  verdict: Pick<ReentryVerdict, 'direction' | 'enter'>;
  exitAt: Date;
  ref: number | null;
  price: number | null;
  opened: { tradingsymbol: string; price: number | null } | null;
  note?: string;
}): string {
  const enter = i.verdict.enter ?? i.original;
  const kind = kindFor(enter);
  const same = i.verdict.direction === 'SAME';
  const where = enter === 'BULLISH' ? (same ? 'back above' : 'rose above') : same ? 'back below' : 'fell below';
  const head = `Re-entry (paper): ${i.underlying} ${kind} ${same ? 'same' : 'opposite'} direction — ${i.underlying} ${fmt(i.price)} ${where} the ${hhmm(i.exitAt)} exit point ${fmt(i.ref)} with the trend ${enter.toLowerCase()}`;
  const tail = i.opened ? `bought ${i.opened.tradingsymbol} @ ${fmt(i.opened.price)}` : `not opened — ${i.note ?? 'no paper trade'}`;
  return `${head}; ${tail}`;
}
