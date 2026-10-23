// apps/api/src/modules/mbm/domain/tick-bars.ts
// 1m OHLC bars built from the owner's live ticks: the fallback for mbm_bars_1m when Angel's historical
// throttle rejects the refresher (prod 2026-10-23: NIFTY 6 min behind, 8 prediction runs skipped). PURE.
//
// A bar is emitted ONLY when it is complete for its minute, so the MBM service can keep data_quality
// 'ok' on it. Complete means all of:
//   - the series had a tick BEFORE the minute started and the stream had no gap since (its opening value
//     is known, not guessed),
//   - at least one tick of the series inside the minute,
//   - the owner's socket delivered ticks (of any token) with no gap > MAX_TICK_GAP_MS over the minute:
//     Angel streams on change, so a quiet series on a live socket is unchanged, not missing,
//   - a later tick closed the minute (the bar is emitted when the first tick of a later minute arrives),
//   - the minute lies inside the NSE session (09:15–15:30 IST).
// Anything else is dropped — the gap stays a gap and the historical fetch fills it.
import type { Candle } from '../../market-data/services/user-historical.util';

const MINUTE_MS = 60_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Longer than this between two ticks of the owner's socket = the stream may have missed changes. */
export const MAX_TICK_GAP_MS = 15_000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

interface SeriesState {
  /** Epoch minute of the bar being built, or null. */
  minute: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  /** False once anything makes the bar being built incomplete. */
  valid: boolean;
  /** The series has ticked and the stream has been gap-free since. */
  primed: boolean;
}

export interface TickBar {
  series: string;
  bar: Candle;
}

const inSession = (minute: number): boolean => {
  const m = Math.floor(((minute * MINUTE_MS + IST_OFFSET_MS) % 86_400_000) / MINUTE_MS);
  return m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
};

export class TickBarBuilder {
  private readonly state = new Map<string, SeriesState>();
  private lastTickMs: number | null = null;

  constructor(series: readonly string[], private readonly maxGapMs = MAX_TICK_GAP_MS) {
    for (const s of series) this.state.set(s, TickBarBuilder.fresh());
  }

  private static fresh(): SeriesState {
    return { minute: null, open: NaN, high: NaN, low: NaN, close: NaN, valid: false, primed: false };
  }

  /** The socket dropped / reconnected: nothing built so far can be trusted to be complete. */
  reset(): void {
    for (const k of this.state.keys()) this.state.set(k, TickBarBuilder.fresh());
    this.lastTickMs = null;
  }

  /**
   * One tick of the owner's socket. `series` is null for a token no tracked series uses (it still counts
   * as the socket's heartbeat). Returns the bars this tick completed.
   */
  onTick(series: string | null, price: number, atMs: number): TickBar[] {
    if (!Number.isFinite(atMs)) return [];
    const last = this.lastTickMs;
    // Ticks of different tokens can arrive a little out of order; the stream clock never runs backwards.
    const t = last !== null && atMs < last ? last : atMs;
    const gap = last !== null && t - last > this.maxGapMs;
    const minute = Math.floor(t / MINUTE_MS);
    const out: TickBar[] = [];

    for (const [name, st] of this.state) {
      if (st.minute !== null && st.minute < minute) {
        // This tick closes the bar. A gap that started before the bar's end hid part of it.
        const endMs = (st.minute + 1) * MINUTE_MS;
        const ok = st.valid && !(gap && (last as number) < endMs) && inSession(st.minute);
        if (ok) {
          out.push({
            series: name,
            bar: { timestamp: new Date(st.minute * MINUTE_MS), open: st.open, high: st.high, low: st.low, close: st.close, volume: 0 },
          });
        }
        st.minute = null;
      }
      if (gap) {
        st.primed = false;
        st.valid = false;
      }
    }
    this.lastTickMs = t;

    const st = series === null ? undefined : this.state.get(series);
    if (!st || !Number.isFinite(price) || price <= 0) return out;
    if (Math.floor(atMs / MINUTE_MS) < minute) return out; // late tick of a minute already closed: not re-opened
    if (st.minute !== minute) {
      st.minute = minute;
      st.open = st.high = st.low = st.close = price;
      st.valid = st.primed; // the opening value is known only if the series ticked before, gap-free
    } else {
      st.high = Math.max(st.high, price);
      st.low = Math.min(st.low, price);
      st.close = price;
    }
    st.primed = true;
    return out;
  }
}
