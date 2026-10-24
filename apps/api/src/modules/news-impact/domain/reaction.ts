/**
 * News impact layer 4 (2026-10-24): how the market actually reacted (factor collection), and the
 * self-review judgement of an impact call. Pure.
 *
 * Points per (cluster, affected symbol / index), all on 1m bars:
 *   anchor  = publish time if inside the NSE session, else the next session's open
 *   p0      = last close at / before the anchor (the open of the first bar for an open anchor)
 *   p15/p60 = the close at anchor + 15 / + 60 min (capped at that session's close)
 *   pClose  = that session's close;  pNextClose = the next session's close
 * Any point without a bar stays null — "no data" is never a zero move.
 */

export interface ReactionPoints {
  p0: number | null;
  p15: number | null;
  p60: number | null;
  pClose: number | null;
  pNextClose: number | null;
}

export interface ReactionRow extends ReactionPoints {
  id: string;
  clusterId: string;
  symbol: string;
  direction: string;
  magnitude: string;
  horizon: string;
  judgeSession: string | null;
  atr: number | null;
  materialType: string;
  firstSource: string;
  sources: string[];
  headline: string;
  oneLine: string;
}

/** Noise band in price for a horizon: 0.15×daily ATR for the +60 m read, 0.3×ATR close-to-next-close. */
export const INTRADAY_BAND_ATR = 0.15;
export const DAYS_BAND_ATR = 0.3;
/** Without an ATR, a typical daily range as a fraction of price: index ~1 %, stock ~2 %. */
export const FALLBACK_ATR_PCT = { INDEX: 0.01, STOCK: 0.02 } as const;

export function isIndexSymbol(s: string): boolean {
  return s === 'NIFTY' || s === 'BANKNIFTY';
}

export interface ReactionVerdict {
  correct: boolean | null;
  move: number | null;
  movePct: number | null;
  band: number | null;
  status: 'RIGHT' | 'WRONG' | 'INSIDE_BAND' | 'NO_DATA' | 'NEUTRAL' | 'NOT_JUDGED_WEEKS';
}

/**
 * INTRADAY: p60 − p0 (fallback pClose − p0 when +60 m is past the close and missing).
 * DAYS: pNextClose − pClose. WEEKS: recorded, not judged. NEUTRAL calls are not judged.
 * Right when the move is beyond the band in the called direction; wrong when beyond it the other way.
 */
export function judgeReaction(r: Pick<ReactionRow, 'direction' | 'horizon' | 'symbol' | 'atr'> & ReactionPoints): ReactionVerdict {
  const none = (status: ReactionVerdict['status']): ReactionVerdict => ({ correct: null, move: null, movePct: null, band: null, status });
  if (r.horizon === 'WEEKS') return none('NOT_JUDGED_WEEKS');
  const [from, to] = r.horizon === 'INTRADAY' ? [r.p0, r.p60 ?? r.pClose] : [r.pClose, r.pNextClose];
  if (from === null || to === null || !(from > 0)) return none('NO_DATA');
  const move = to - from;
  const atr = r.atr !== null && r.atr > 0 ? r.atr : from * (isIndexSymbol(r.symbol) ? FALLBACK_ATR_PCT.INDEX : FALLBACK_ATR_PCT.STOCK);
  const band = atr * (r.horizon === 'INTRADAY' ? INTRADAY_BAND_ATR : DAYS_BAND_ATR);
  const movePct = Math.round((move / from) * 10_000) / 100;
  const base = { move: Math.round(move * 100) / 100, movePct, band: Math.round(band * 100) / 100 };
  if (r.direction !== 'BULL' && r.direction !== 'BEAR') return { correct: null, ...base, status: 'NEUTRAL' };
  const signed = r.direction === 'BULL' ? move : -move;
  if (signed > band) return { correct: true, ...base, status: 'RIGHT' };
  if (signed < -band) return { correct: false, ...base, status: 'WRONG' };
  return { correct: null, ...base, status: 'INSIDE_BAND' };
}

/** The session (IST date) a reaction is judged on: the anchor's session (INTRADAY) or the next one (DAYS / WEEKS). */
export function judgeSessionOf(horizon: string, anchorSession: string, nextSession: string | null): string | null {
  return horizon === 'INTRADAY' ? anchorSession : nextSession;
}

/** A 1m bar (start time, UTC ms) for point picking. */
export interface Bar {
  t: number;
  open: number;
  close: number;
}

/** The close of the last bar starting at or before `at` but not before `notBefore`; null when none. */
export function closeAtOrBefore(bars: readonly Bar[], at: number, notBefore: number): number | null {
  let best: Bar | null = null;
  for (const b of bars) if (b.t <= at && b.t >= notBefore && (!best || b.t > best.t)) best = b;
  return best ? best.close : null;
}

/** The open of the first bar at or after `at` (≤ `within` ms later); null when none. */
export function openAtOrAfter(bars: readonly Bar[], at: number, within: number): number | null {
  let best: Bar | null = null;
  for (const b of bars) if (b.t >= at && b.t <= at + within && (!best || b.t < best.t)) best = b;
  return best ? best.open : null;
}

export interface SessionSpan {
  openAt: number;
  closeAt: number;
}

/**
 * The points available from `bars` for an anchor in `session` (and `next` session). Points whose time
 * has not come yet (> `now`) are left null so a later pass fills them.
 */
export function pointsFrom(bars: readonly Bar[], anchorAt: number, anchorIsOpen: boolean, session: SessionSpan, next: SessionSpan | null, now: number): ReactionPoints {
  const lastBarOf = (s: SessionSpan) => s.closeAt - 60_000;
  const p0 = anchorIsOpen ? openAtOrAfter(bars, anchorAt, 5 * 60_000) : closeAtOrBefore(bars, anchorAt, session.openAt);
  const at = (mins: number) => {
    const t = Math.min(anchorAt + mins * 60_000, lastBarOf(session));
    return t + 60_000 <= now ? closeAtOrBefore(bars, t, session.openAt) : null;
  };
  const pClose = session.closeAt <= now ? closeAtOrBefore(bars, lastBarOf(session), session.openAt) : null;
  const pNextClose = next && next.closeAt <= now ? closeAtOrBefore(bars, lastBarOf(next), next.openAt) : null;
  return { p0, p15: at(15), p60: at(60), pClose, pNextClose };
}

/** Merge newly found points over the stored ones (a stored value is never overwritten with null). */
export function mergePoints(stored: ReactionPoints, found: ReactionPoints): ReactionPoints {
  return {
    p0: stored.p0 ?? found.p0,
    p15: stored.p15 ?? found.p15,
    p60: stored.p60 ?? found.p60,
    pClose: stored.pClose ?? found.pClose,
    pNextClose: stored.pNextClose ?? found.pNextClose,
  };
}

export const isComplete = (p: ReactionPoints) => p.p0 !== null && p.p15 !== null && p.p60 !== null && p.pClose !== null && p.pNextClose !== null;

/** Average true range over daily OHLC (oldest first); null with fewer than 5 days. */
export function atrOf(days: ReadonlyArray<{ high: number; low: number; close: number }>, n = 14): number | null {
  if (days.length < 5) return null;
  const trs: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const d = days[i];
    const pc = days[i - 1].close;
    trs.push(Math.max(d.high - d.low, Math.abs(d.high - pc), Math.abs(d.low - pc)));
  }
  const last = trs.slice(-n);
  return last.length ? Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 100) / 100 : null;
}
