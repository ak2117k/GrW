/**
 * VENUE SESSION FILTER FOR BARS (2026-11-24). Pure, no I/O, no clock. The one source of truth for "which
 * minutes of an IST day are the venue's trading session" when bars are READ from candles_1m.
 *
 * Prod 2026-11-23: candles_1m holds NSE index bars outside the session — flat copies from ~02:00, the PRE-OPEN
 * auction 09:00–09:08 (BANKNIFTY's 09:00 bar O 64635 H 64912 L 63796 C 64861: a 1,100-pt range that never traded,
 * 09:02 indicative print 65,489), flat bars 09:09–09:14 and flat post-close bars 15:30 → evening. Rolled to 15m
 * without a filter they make a junk 09:00 bucket that is the newest CLOSED bar until 09:30, plus dozens of flat
 * buckets a day that dilute EMAs / ATR.
 *
 * Windows ([fromMin, toMin), IST minutes after midnight; a bar or bucket must START inside):
 *   NSE / NFO / BSE / BFO  09:15–15:30
 *   MCX*                   09:00–23:55 (the late close; bars after the real close are rare)
 *   anything else          null = no filter (callers keep every bar, today's behaviour)
 * An index option is NFO/BFO but its UNDERLYING line is NSE/BSE: same window either way.
 *
 * 15-minute (or any N-minute) buckets are aligned to the session OPEN (NSE 09:15, 09:30, …; MCX 09:00, 09:15, …),
 * so a bucket never mixes pre-open and session minutes. Epoch-aligned 5m/15m buckets (date_bin from 1970 or from
 * 09:15) coincide with these for both venues; a bucket whose start is NOT on the session grid is dropped.
 */

export interface SessionMinutes {
  fromMin: number;
  toMin: number;
}

const MIN = 60_000;
const DAY = 86_400_000;
const IST_MS = 330 * MIN;

export const NSE_SESSION: SessionMinutes = Object.freeze({ fromMin: 9 * 60 + 15, toMin: 15 * 60 + 30 });
export const MCX_SESSION: SessionMinutes = Object.freeze({ fromMin: 9 * 60, toMin: 23 * 60 + 55 });

/** The venue's trading minutes (IST); null for a venue with no known session (keep every bar). */
export function venueSession(exchange: string | null | undefined): SessionMinutes | null {
  const ex = String(exchange ?? '').trim().toUpperCase();
  if (ex === 'NSE' || ex === 'NFO' || ex === 'BSE' || ex === 'BFO') return NSE_SESSION;
  if (ex.startsWith('MCX')) return MCX_SESSION;
  return null;
}

/** IST minute of the day of an epoch-ms timestamp. */
export const istMinuteOf = (ts: number): number => Math.floor((((ts + IST_MS) % DAY) + DAY) % DAY / MIN);
/** IST day number (days since 1970-01-01 IST). */
export const istDayOf = (ts: number): number => Math.floor((ts + IST_MS) / DAY);

/** The bar (or bucket) STARTING at `ts` is inside the venue's session; true for an unknown venue. */
export function inVenueSession(ts: number, exchange: string | null | undefined): boolean {
  const s = venueSession(exchange);
  if (!s) return true;
  const m = istMinuteOf(ts);
  return m >= s.fromMin && m < s.toMin;
}

/**
 * Only the bars that START inside the venue's session. With `stepMin` > 1 (already-bucketed bars) a bucket must
 * also start on the session grid (open + k × step), else it mixes off-session minutes and is dropped. Order kept.
 */
export function sessionOnlyBars<B extends { ts: number }>(bars: readonly B[], exchange: string | null | undefined, stepMin = 1): B[] {
  const s = venueSession(exchange);
  if (!s) return [...bars];
  const step = Math.max(1, Math.floor(stepMin));
  return bars.filter((b) => {
    if (!Number.isFinite(b.ts)) return false;
    const m = istMinuteOf(b.ts);
    return m >= s.fromMin && m < s.toMin && (m - s.fromMin) % step === 0;
  });
}

/** The start (epoch ms) of the session-aligned `stepMin` bucket holding the minute `ts`; null when off-session. */
export function sessionBucketStart(ts: number, exchange: string | null | undefined, stepMin: number): number | null {
  const s = venueSession(exchange);
  const w = stepMin * MIN;
  if (!s) return Math.floor(ts / w) * w;
  const m = istMinuteOf(ts);
  if (m < s.fromMin || m >= s.toMin) return null;
  const dayStart = istDayOf(ts) * DAY - IST_MS; // IST midnight, epoch ms
  return dayStart + (s.fromMin + Math.floor((m - s.fromMin) / stepMin) * stepMin) * MIN;
}

export interface OhlcBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

/**
 * 1-minute bars rolled into session-aligned `stepMin` buckets (bucket start ts, ascending), off-session minutes
 * dropped BEFORE bucketing. Bars with a non-positive low or high < low are skipped. The forming bucket is kept;
 * callers filter "closed" (ts + step <= now) themselves.
 */
export function rollToSessionBuckets(bars: readonly OhlcBar[], exchange: string | null | undefined, stepMin: number): OhlcBar[] {
  const by = new Map<number, OhlcBar>();
  for (const b of [...bars].sort((x, y) => x.ts - y.ts)) {
    if (![b.ts, b.open, b.high, b.low, b.close].every(Number.isFinite) || !(b.low > 0) || b.high < b.low) continue;
    const k = sessionBucketStart(b.ts, exchange, stepMin);
    if (k === null) continue;
    const p = by.get(k);
    const vol = b.volume == null ? null : Number(b.volume);
    if (!p) by.set(k, { ts: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: vol });
    else by.set(k, { ...p, high: Math.max(p.high, b.high), low: Math.min(p.low, b.low), close: b.close, volume: p.volume == null && vol == null ? null : (p.volume ?? 0) + (vol ?? 0) });
  }
  return [...by.values()].sort((a, b) => a.ts - b.ts);
}
