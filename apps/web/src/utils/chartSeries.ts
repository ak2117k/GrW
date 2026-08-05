/**
 * The chart's candle series: one immutable value, mutated only by pure
 * transitions.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The live chart previously kept a bar's identity split across three places —
 * `candles[].time` (a gap-compressed axis time), a separate `realTimeMap`
 * (compressed -> real market time) and a `lastRealBucketRef` — and mutated all
 * three from inside React `setState` updaters, from four independent writers
 * (WS tick, 20s REST poll, reconnect gap-fill, infinite-history prepend).
 *
 * React updaters must be pure. Because these were not, a bar and its map entry
 * could commit independently, and the axis formatter's `map.get(t) ?? t`
 * fallback then rendered the *compressed* time as if it were real — which,
 * since compression subtracts the overnight gap, looks exactly like a valid
 * timestamp from the previous day. That is the "candle in the wrong place with
 * yesterday's date" symptom, and it is why fixing it kept failing: the bug was
 * in the state model, not in any one writer.
 *
 * The fix is structural:
 *   1. `realTime` lives ON the bar. There is no second structure to desync,
 *      and `realTimeMap` is derived (see `toRealTimeMap`), never stored.
 *   2. The "which bucket is forming" cursor is derived from the last bar,
 *      not tracked in a ref that a discarded render can advance.
 *   3. Every transition is a pure `(series, input) => series` function that
 *      returns the SAME REFERENCE when nothing changed, and copy-on-writes
 *      only the bars it touched — so `planRender` can diff by `===` and tell
 *      the canvas exactly what happened.
 *   4. Tick bucketing is anchored on the last bar's real time rather than on
 *      the UTC epoch grid, so 30m/4h/1d bars stamped at 09:15 IST stay on the
 *      broker's grid instead of being floored to a UTC boundary.
 *
 * TIME MODEL: `time` is the COMPRESSED axis time actually plotted (overnight,
 * weekend and holiday gaps collapsed to a single bar step so intraday charts
 * read contiguously). `realTime` is the true market bucket start, in unix
 * seconds, used for every label, every merge decision and every comparison.
 * Never compare compressed times across bars for anything but ordering.
 */

/** A bar as the broker gives it to us: real unix-second timestamp. */
export interface RealBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A bar as plotted, carrying its own real market time. */
export interface SeriesBar {
  /** Gap-compressed axis time — what lightweight-charts actually plots. */
  time: number;
  /** True market bucket start (unix seconds). The bar's real identity. */
  realTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * A live tick has folded into this bar, so its `close` is fresher than a
   * REST bar for the same bucket (which can be up to ~30s stale). Cleared
   * once the broker closes the bar.
   */
  live?: boolean;
  /**
   * Cumulative day-volume at the instant this bar was opened by a tick. The
   * feed sends `volume_trade_for_the_day`, so per-bar volume is the delta from
   * this anchor — NOT a running sum of the tick field.
   */
  volAnchor?: number;
}

export interface ChartSeries {
  bars: SeriesBar[];
  /** Timeframe in seconds. Bars from a different timeframe must never merge. */
  tfSec: number;
}

export interface LiveTick {
  /** Tick time in unix SECONDS. */
  time: number;
  price: number;
  /** Cumulative day volume from the feed, if present. */
  volume?: number;
}

export function emptySeries(tfSec: number): ChartSeries {
  return { bars: [], tfSec };
}

function isPrice(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Broker bars -> validated, ascending, de-duplicated bars keyed by REAL time.
 *
 * Deliberately does NOT re-bucket the timestamps: the broker already stamps
 * each bar at its session-grid boundary, and flooring to the UTC epoch grid
 * corrupts every timeframe that does not divide the +05:30 offset evenly
 * (09:15 IST 30m bars would land on 09:00).
 *
 * Deliberately does NOT drop flat bars either. The old code discarded any bar
 * with `high === low && open === close`, which silently punched holes into
 * quiet index sessions and into any bar that had only seen one tick so far.
 */
function normalize(input: readonly RealBar[]): SeriesBar[] {
  const byReal = new Map<number, SeriesBar>();
  for (const b of input) {
    if (!b || !Number.isFinite(b.time)) continue;
    if (!isPrice(b.open) || !isPrice(b.high) || !isPrice(b.low) || !isPrice(b.close)) continue;
    const realTime = Math.floor(b.time);
    if (byReal.has(realTime)) continue; // first occurrence wins
    byReal.set(realTime, {
      time: realTime, // placeholder; the caller assigns the compressed time
      realTime,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: Number.isFinite(b.volume) ? b.volume : 0,
    });
  }
  return Array.from(byReal.values()).sort((a, b) => a.realTime - b.realTime);
}

/** Two bars are the same if every rendered field matches. */
function sameBar(a: SeriesBar, b: SeriesBar): boolean {
  return (
    a.time === b.time &&
    a.realTime === b.realTime &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

/**
 * Lay validated bars onto the compressed axis. Any inter-bar gap LARGER than
 * 2x the timeframe (overnight / weekend / holiday) collapses to exactly one
 * bar step; a gap of exactly 2x is a single genuinely-missing bar and is left
 * alone so the hole stays visible.
 */
function layout(sorted: SeriesBar[], tfSec: number): SeriesBar[] {
  const bars: SeriesBar[] = new Array(sorted.length);
  let prevReal = 0;
  let prevCompressed = 0;
  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i];
    let time: number;
    if (i === 0) {
      time = bar.realTime;
    } else {
      const gap = bar.realTime - prevReal;
      time = prevCompressed + (gap > tfSec * 2 ? tfSec : gap);
    }
    bars[i] = bar.time === time ? bar : { ...bar, time };
    prevReal = bar.realTime;
    prevCompressed = time;
  }
  return bars;
}

/** Cold start: broker bars -> a fresh series. */
export function buildSeries(input: readonly RealBar[], tfSec: number): ChartSeries {
  return { bars: layout(normalize(input), tfSec), tfSec };
}

/** Derived compressed-time -> real-time map for the chart's axis formatters. */
export function toRealTimeMap(series: ChartSeries): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of series.bars) m.set(b.time, b.realTime);
  return m;
}

/**
 * Fold a live LTP into the forming bar, or open the next one.
 *
 * The new bar's real time is `last.realTime + tfSec` — the broker's own grid,
 * extended by one slot. That is only sound WITHIN a session, so a tick more
 * than 2 timeframes past the last bar (a session boundary, or bars we missed
 * while disconnected) opens nothing: the 20s REST poll owns those, because it
 * carries the broker's authoritative timestamps. Guessing here is what stamped
 * a new day's first bar with yesterday's date.
 */
export function applyTick(series: ChartSeries, tick: LiveTick): ChartSeries {
  const { bars, tfSec } = series;
  if (bars.length === 0) return series; // cold start belongs to buildSeries
  if (!isPrice(tick.price) || !Number.isFinite(tick.time)) return series;

  const last = bars[bars.length - 1];
  const elapsed = tick.time - last.realTime;
  if (elapsed < 0) return series; // late / out-of-order tick

  if (elapsed < tfSec) {
    // Still inside the forming bar.
    const volume =
      last.volAnchor != null && Number.isFinite(tick.volume)
        ? Math.max(0, (tick.volume as number) - last.volAnchor)
        : last.volume;
    const updated: SeriesBar = {
      ...last,
      high: Math.max(last.high, tick.price),
      low: Math.min(last.low, tick.price),
      close: tick.price,
      volume,
      live: true,
    };
    if (sameBar(updated, last) && last.live) return series;
    return { ...series, bars: [...bars.slice(0, -1), updated] };
  }

  if (elapsed >= tfSec * 2) {
    // Session gap or missed bars — do not invent a timestamp.
    return series;
  }

  const bar: SeriesBar = {
    time: last.time + tfSec,
    realTime: last.realTime + tfSec,
    open: tick.price,
    high: tick.price,
    low: tick.price,
    close: tick.price,
    volume: 0,
    live: true,
    volAnchor: Number.isFinite(tick.volume) ? tick.volume : undefined,
  };
  return { ...series, bars: [...bars, bar] };
}

/**
 * A closed bar is whatever the broker says it is. The bar still forming keeps
 * its live `close` (ticks are fresher than a <=30s-stale REST bar) but adopts
 * the broker's `open` — a tick-opened bar's `open` is merely the first LTP we
 * happened to see, not the true bar open — and widens to cover both ranges.
 */
function mergeRest(cur: SeriesBar, rb: SeriesBar, forming: boolean): SeriesBar {
  if (!forming) return { ...rb, time: cur.time };
  return {
    ...cur,
    open: rb.open,
    high: Math.max(cur.high, rb.high),
    low: Math.min(cur.low, rb.low),
    close: cur.live ? cur.close : rb.close,
    volume: Math.max(cur.volume, rb.volume),
  };
}

/**
 * Merge a batch of broker bars (the 20s live-edge poll, or the reconnect
 * gap-fill) into the series.
 *
 * Bars are matched by REAL time, so a bar a tick already opened is corrected
 * in place rather than appended a second time. Bars newer than the series are
 * appended at the next compressed slots. If the batch fills a hole INSIDE the
 * existing range — which happens whenever the broker throttles a history chunk
 * and returns it on a later poll — the series is rebuilt so those bars land in
 * chronological order instead of being appended at the right edge.
 */
export function applyRealBars(series: ChartSeries, input: readonly RealBar[]): ChartSeries {
  const { bars, tfSec } = series;
  if (bars.length === 0) return series; // cold start belongs to buildSeries
  const incoming = normalize(input);
  if (incoming.length === 0) return series;

  const oldestReal = bars[0].realTime;
  const newestReal = bars[bars.length - 1].realTime;
  const newestIncoming = incoming[incoming.length - 1].realTime;

  const indexByReal = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) indexByReal.set(bars[i].realTime, i);

  // A bar strictly inside our range that we do not have is a hole being
  // filled. Ordering cannot be preserved by appending, so rebuild.
  for (const rb of incoming) {
    if (
      rb.realTime > oldestReal &&
      rb.realTime < newestReal &&
      !indexByReal.has(rb.realTime)
    ) {
      return rebuild(series, incoming, indexByReal);
    }
  }

  let next: SeriesBar[] | null = null;
  const appended: SeriesBar[] = [];
  let lastCompressed = bars[bars.length - 1].time;
  let cursorReal = newestReal;

  for (const rb of incoming) {
    const idx = indexByReal.get(rb.realTime);
    if (idx !== undefined) {
      const cur = (next ?? bars)[idx];
      const forming = idx === bars.length - 1 && rb.realTime === newestIncoming;
      const merged = mergeRest(cur, rb, forming);
      if (!sameBar(merged, cur)) {
        next ??= bars.slice();
        next[idx] = merged;
      }
    } else if (rb.realTime > cursorReal) {
      lastCompressed += tfSec;
      appended.push({ ...rb, time: lastCompressed });
      cursorReal = rb.realTime;
    }
    // Older than everything we hold: that is `prependBars`' job, not ours.
  }

  if (!next && appended.length === 0) return series;
  const merged = next ?? bars.slice();
  return { ...series, bars: appended.length > 0 ? merged.concat(appended) : merged };
}

/**
 * Re-lay the whole series from the union of what we hold and what just
 * arrived. Only reached when a poll fills an interior hole; cost is one pass
 * over a few hundred bars.
 */
function rebuild(
  series: ChartSeries,
  incoming: SeriesBar[],
  indexByReal: Map<number, number>,
): ChartSeries {
  const { bars, tfSec } = series;
  const newestReal = bars[bars.length - 1].realTime;
  const newestIncoming = incoming[incoming.length - 1].realTime;
  const union = new Map<number, SeriesBar>();
  for (const b of bars) union.set(b.realTime, b);
  for (const rb of incoming) {
    const idx = indexByReal.get(rb.realTime);
    if (idx === undefined) {
      union.set(rb.realTime, rb);
    } else {
      const cur = bars[idx];
      const forming = idx === bars.length - 1 && rb.realTime === newestIncoming && rb.realTime === newestReal;
      union.set(rb.realTime, mergeRest(cur, rb, forming));
    }
  }
  const sorted = Array.from(union.values()).sort((a, b) => a.realTime - b.realTime);
  return { bars: layout(sorted, tfSec), tfSec };
}

/**
 * Add OLDER bars to the front without shifting any existing bar's compressed
 * time, so the user's scroll position survives an infinite-history page.
 * Applies the same >2x-timeframe gap-collapse rule within the older chunk.
 */
export function prependBars(
  series: ChartSeries,
  input: readonly RealBar[],
): { series: ChartSeries; prepended: number } {
  const { bars, tfSec } = series;
  const oldestReal = bars.length > 0 ? bars[0].realTime : null;
  const older = normalize(input).filter(
    (b) => oldestReal === null || b.realTime < oldestReal,
  );
  if (older.length === 0) return { series, prepended: 0 };
  if (bars.length === 0) {
    return { series: { bars: layout(older, tfSec), tfSec }, prepended: older.length };
  }

  // Walk newest -> oldest, stepping back by each bar's (gap-collapsed) spacing,
  // anchored one timeframe before the existing first bar.
  const out: SeriesBar[] = new Array(older.length);
  let time = bars[0].time - tfSec;
  for (let i = older.length - 1; i >= 0; i--) {
    out[i] = { ...older[i], time };
    if (i > 0) {
      const gap = older[i].realTime - older[i - 1].realTime;
      time -= gap > tfSec * 2 ? tfSec : gap;
    }
  }
  return { series: { ...series, bars: [...out, ...bars] }, prepended: out.length };
}

/**
 * What the canvas must be told about a bars change.
 *
 * lightweight-charts' `update()` can only touch the LAST bar (mutate it, or
 * append one after it). The old code approximated that with a length delta of
 * <= 1, which was wrong in the exact case the REST poll produces: correct an
 * earlier bar AND append a new one. That looked like "+1 bar", so only the
 * appended bar was pushed and the correction never reached the canvas — React
 * state and the drawn chart then disagreed permanently.
 *
 * Diffing by reference is exact here because every transition copy-on-writes
 * only the bars it touched.
 */
export type RenderPlan =
  | { kind: 'none' }
  | { kind: 'update'; bar: SeriesBar }
  | { kind: 'reset' };

export function planRender(
  prev: readonly SeriesBar[] | null,
  next: readonly SeriesBar[],
): RenderPlan {
  if (prev === next) return { kind: 'none' };
  if (!prev || prev.length === 0 || next.length === 0) return { kind: 'reset' };
  if (next.length !== prev.length && next.length !== prev.length + 1) {
    return { kind: 'reset' };
  }

  // Everything the two have in common, except a possibly-mutated final bar of
  // `prev`, must be reference-identical.
  const shared = next.length === prev.length ? prev.length - 1 : prev.length;
  for (let i = 0; i < shared; i++) {
    if (prev[i] !== next[i]) return { kind: 'reset' };
  }

  if (next.length === prev.length) {
    const a = prev[prev.length - 1];
    const b = next[next.length - 1];
    if (a === b) return { kind: 'none' };
    // A different bar occupying the same slot is a reflow, not an update.
    if (a.time !== b.time) return { kind: 'reset' };
    return { kind: 'update', bar: b };
  }

  return { kind: 'update', bar: next[next.length - 1] };
}
