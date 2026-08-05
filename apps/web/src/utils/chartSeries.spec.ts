import { describe, it, expect } from 'vitest';
import {
  buildSeries,
  applyTick,
  applyRealBars,
  prependBars,
  planRender,
  toRealTimeMap,
  emptySeries,
  type RealBar,
  type SeriesBar,
} from './chartSeries';

const TF = 60; // 1-minute bars, in seconds

/** A real (broker) bar with deterministic OHLCV derived from its timestamp. */
function real(time: number, over: Partial<RealBar> = {}): RealBar {
  return {
    time,
    open: time,
    high: time + 1,
    low: time - 1,
    close: time + 0.5,
    volume: 100,
    ...over,
  };
}

const times = (bars: SeriesBar[]) => bars.map((b) => b.time);
const reals = (bars: SeriesBar[]) => bars.map((b) => b.realTime);

// ---------------------------------------------------------------------------
// buildSeries — gap compression + normalisation
// ---------------------------------------------------------------------------

describe('buildSeries', () => {
  it('lays contiguous bars out with compressed time === real time', () => {
    const s = buildSeries([real(1000), real(1060), real(1120)], TF);
    expect(times(s.bars)).toEqual([1000, 1060, 1120]);
    expect(reals(s.bars)).toEqual([1000, 1060, 1120]);
  });

  it('collapses a gap larger than 2x the timeframe down to one bar step', () => {
    // 1000, 1060, then an overnight-sized hole, then 50000.
    const s = buildSeries([real(1000), real(1060), real(50_000)], TF);
    expect(times(s.bars)).toEqual([1000, 1060, 1120]);
    // Real times are preserved on the bars — that is the whole point.
    expect(reals(s.bars)).toEqual([1000, 1060, 50_000]);
  });

  it('leaves a gap of exactly 2x the timeframe alone (one genuinely missing bar)', () => {
    const s = buildSeries([real(1000), real(1120)], TF);
    expect(times(s.bars)).toEqual([1000, 1120]);
  });

  it('sorts, and de-dupes by real time keeping the first occurrence', () => {
    const s = buildSeries([real(1060), real(1000), real(1060, { close: 999 })], TF);
    expect(reals(s.bars)).toEqual([1000, 1060]);
    expect(s.bars[1].close).toBe(1060.5);
  });

  it('KEEPS flat bars (open===close and high===low)', () => {
    // Regression: the old cleanCandles dropped these, punching holes into the
    // series for quiet index bars and for a bar with a single tick so far.
    const flat: RealBar = { time: 1060, open: 50, high: 50, low: 50, close: 50, volume: 0 };
    const s = buildSeries([real(1000), flat], TF);
    expect(reals(s.bars)).toEqual([1000, 1060]);
  });

  it('drops bars with non-positive or non-finite prices', () => {
    const s = buildSeries(
      [real(1000), real(1060, { low: 0 }), real(1120, { close: NaN }), real(1180)],
      TF,
    );
    expect(reals(s.bars)).toEqual([1000, 1180]);
  });

  it('does NOT re-bucket broker timestamps to the UTC epoch grid', () => {
    // 09:15 IST == 03:45 UTC. A 30m series anchored there must keep 03:45,
    // not be floored to 03:30 by `Math.floor(t / 1800) * 1800`.
    const t0 = Date.UTC(2026, 7, 5, 3, 45) / 1000;
    const s = buildSeries([real(t0), real(t0 + 1800)], 1800);
    expect(reals(s.bars)).toEqual([t0, t0 + 1800]);
  });
});

// ---------------------------------------------------------------------------
// applyTick — folding a live LTP into the forming bar
// ---------------------------------------------------------------------------

describe('applyTick', () => {
  const base = () => buildSeries([real(1000), real(1060)], TF);

  it('extends the forming bar in place: high/low/close move, open does not', () => {
    const s = applyTick(base(), { time: 1075, price: 5000 });
    expect(s.bars).toHaveLength(2);
    const last = s.bars[1];
    expect(last.open).toBe(1060);
    expect(last.high).toBe(5000);
    expect(last.close).toBe(5000);
    expect(last.low).toBe(1059);
    expect(last.time).toBe(1060);
  });

  it('appends a new bar on the next grid slot when the tick crosses the boundary', () => {
    const s = applyTick(base(), { time: 1125, price: 7 });
    expect(times(s.bars)).toEqual([1000, 1060, 1120]);
    expect(reals(s.bars)).toEqual([1000, 1060, 1120]);
    expect(s.bars[2]).toMatchObject({ open: 7, high: 7, low: 7, close: 7 });
  });

  it('anchors the new bar on the LAST BAR grid, not on the UTC epoch grid', () => {
    // 30m bars stamped at 09:15 IST (03:45 UTC). A tick at 09:46 IST belongs to
    // the 09:45 bar. Epoch-flooring would have produced 09:30.
    const t0 = Date.UTC(2026, 7, 5, 3, 45) / 1000;
    const s0 = buildSeries([real(t0)], 1800);
    const s = applyTick(s0, { time: t0 + 1860, price: 9 });
    expect(reals(s.bars)).toEqual([t0, t0 + 1800]);
  });

  it('does NOT open a bar across a session gap — leaves that to the REST poll', () => {
    // A tick more than 2 timeframes past the last bar means we are at a session
    // boundary or have missed bars. Guessing the next slot would stamp the new
    // day's first bar with yesterday's timestamp.
    const s0 = base();
    const s = applyTick(s0, { time: 1060 + TF * 10, price: 42 });
    expect(s).toBe(s0);
  });

  it('ignores ticks older than the forming bar, and non-positive prices', () => {
    const s0 = base();
    expect(applyTick(s0, { time: 900, price: 42 })).toBe(s0);
    expect(applyTick(s0, { time: 1075, price: 0 })).toBe(s0);
    expect(applyTick(s0, { time: 1075, price: NaN })).toBe(s0);
  });

  it('is a no-op on an empty series (cold start is owned by buildSeries)', () => {
    const s0 = emptySeries(TF);
    expect(applyTick(s0, { time: 1075, price: 42 })).toBe(s0);
  });

  it('returns the same reference when nothing actually changed', () => {
    const s0 = applyTick(base(), { time: 1075, price: 5000 });
    const s1 = applyTick(s0, { time: 1076, price: 5000 });
    expect(s1).toBe(s0);
  });

  it('derives per-bar volume from the cumulative day volume, never accumulates it', () => {
    // Regression: the old handler did `last.volume + tick.volume`, and the feed
    // sends volume_trade_for_the_day — so every tick added the WHOLE day again.
    let s = applyTick(base(), { time: 1125, price: 7, volume: 1_000_000 });
    s = applyTick(s, { time: 1130, price: 8, volume: 1_000_400 });
    s = applyTick(s, { time: 1140, price: 9, volume: 1_000_900 });
    expect(s.bars[2].volume).toBe(900);
  });

  it('leaves untouched bars reference-identical (so the render diff can trust ===)', () => {
    const s0 = base();
    const s1 = applyTick(s0, { time: 1075, price: 5000 });
    expect(s1.bars[0]).toBe(s0.bars[0]);
  });
});

// ---------------------------------------------------------------------------
// applyRealBars — merging the 20s REST live-edge poll
// ---------------------------------------------------------------------------

describe('applyRealBars', () => {
  it('corrects a closed bar wholesale from the broker values', () => {
    const s0 = buildSeries([real(1000), real(1060)], TF);
    const s = applyRealBars(s0, [real(1000, { high: 12_345 }), real(1060), real(1120)]);
    expect(s.bars[0].high).toBe(12_345);
    expect(times(s.bars)).toEqual([1000, 1060, 1120]);
  });

  it('appends newer bars at the next compressed slots', () => {
    const s0 = buildSeries([real(1000)], TF);
    const s = applyRealBars(s0, [real(1060), real(1120)]);
    expect(times(s.bars)).toEqual([1000, 1060, 1120]);
    expect(reals(s.bars)).toEqual([1000, 1060, 1120]);
  });

  it('keeps the live close on the still-forming bar but adopts the broker open', () => {
    // The bar was opened by a tick, so its `open` is just the first tick's LTP.
    // The broker knows the true open; the tick knows the freshest close.
    let s = applyTick(buildSeries([real(1000)], TF), { time: 1065, price: 500 });
    expect(s.bars[1].open).toBe(500);
    s = applyRealBars(s, [real(1060, { open: 111, high: 600, low: 90, close: 400 })]);
    const forming = s.bars[1];
    expect(forming.open).toBe(111); // broker is authoritative for the open
    expect(forming.close).toBe(500); // tick is fresher than the <=30s-stale REST bar
    expect(forming.high).toBe(600); // widened by the broker
    expect(forming.low).toBe(90);
  });

  it('takes the broker close on the forming bar when no tick has landed yet', () => {
    const s0 = buildSeries([real(1000), real(1060)], TF);
    const s = applyRealBars(s0, [real(1060, { close: 777 })]);
    expect(s.bars[1].close).toBe(777);
  });

  it('rebuilds when the poll fills a hole INSIDE the existing range', () => {
    // Angel silently drops chunks; a later poll can return the missing bars.
    // They must land in chronological order, not be appended at the right edge.
    const s0 = buildSeries([real(1000), real(1180)], TF);
    expect(times(s0.bars)).toEqual([1000, 1060]); // gap was compressed
    const s = applyRealBars(s0, [real(1060), real(1120), real(1180)]);
    expect(reals(s.bars)).toEqual([1000, 1060, 1120, 1180]);
    expect(times(s.bars)).toEqual([1000, 1060, 1120, 1180]);
  });

  it('ignores bars older than the series (that is loadOlder territory)', () => {
    const s0 = buildSeries([real(1000), real(1060)], TF);
    const s = applyRealBars(s0, [real(880), real(940)]);
    expect(s).toBe(s0);
  });

  it('returns the same reference when the poll brings nothing new', () => {
    const s0 = buildSeries([real(1000), real(1060)], TF);
    expect(applyRealBars(s0, [real(1000), real(1060)])).toBe(s0);
    expect(applyRealBars(s0, [])).toBe(s0);
  });

  it('is a no-op on an empty series', () => {
    const s0 = emptySeries(TF);
    expect(applyRealBars(s0, [real(1000)])).toBe(s0);
  });

  it('never appends a duplicate of a bar a tick already opened', () => {
    // The exact double-write that produced two bars for one bucket.
    let s = applyTick(buildSeries([real(1000)], TF), { time: 1065, price: 500 });
    s = applyRealBars(s, [real(1000), real(1060)]);
    expect(reals(s.bars)).toEqual([1000, 1060]);
  });
});

// ---------------------------------------------------------------------------
// prependBars — infinite history scroll
// ---------------------------------------------------------------------------

describe('prependBars', () => {
  it('steps older bars back by exactly one timeframe when contiguous', () => {
    const s0 = buildSeries([real(1000), real(1060), real(1120)], TF);
    const { series, prepended } = prependBars(s0, [real(880), real(940)]);
    expect(prepended).toBe(2);
    expect(times(series.bars)).toEqual([880, 940, 1000, 1060, 1120]);
    expect(reals(series.bars)).toEqual([880, 940, 1000, 1060, 1120]);
  });

  it('collapses a gap inside the older chunk to one step', () => {
    const s0 = buildSeries([real(1000)], TF);
    const { series } = prependBars(s0, [real(100), real(940)]);
    expect(times(series.bars)).toEqual([880, 940, 1000]);
    expect(reals(series.bars)).toEqual([100, 940, 1000]);
  });

  it('does not shift the existing bars compressed times', () => {
    const s0 = buildSeries([real(1000), real(50_000)], TF);
    const before = times(s0.bars);
    const { series } = prependBars(s0, [real(940)]);
    expect(times(series.bars).slice(1)).toEqual(before);
  });

  it('drops older bars that are not strictly older than the series', () => {
    const s0 = buildSeries([real(1000), real(1060)], TF);
    const { series, prepended } = prependBars(s0, [real(1000), real(1060)]);
    expect(prepended).toBe(0);
    expect(series).toBe(s0);
  });

  it('lays a chunk out from its own first real time when the series is empty', () => {
    const { series, prepended } = prependBars(emptySeries(TF), [real(940), real(1000)]);
    expect(prepended).toBe(2);
    expect(times(series.bars)).toEqual([940, 1000]);
  });
});

// ---------------------------------------------------------------------------
// toRealTimeMap — derived, never stored
// ---------------------------------------------------------------------------

describe('toRealTimeMap', () => {
  it('maps every plotted bar time to its real market time', () => {
    const s = buildSeries([real(1000), real(50_000)], TF);
    const m = toRealTimeMap(s);
    expect(m.get(1000)).toBe(1000);
    expect(m.get(1060)).toBe(50_000);
    // Every plotted bar is present — a lookup miss is structurally impossible.
    expect(m.size).toBe(s.bars.length);
  });
});

// ---------------------------------------------------------------------------
// planRender — what the canvas must be told
// ---------------------------------------------------------------------------

describe('planRender', () => {
  const s0 = buildSeries([real(1000), real(1060)], TF);

  it('does nothing when the bars array is unchanged', () => {
    expect(planRender(s0.bars, s0.bars)).toEqual({ kind: 'none' });
  });

  it('resets on first paint and on an emptied series', () => {
    expect(planRender(null, s0.bars).kind).toBe('reset');
    expect(planRender(s0.bars, []).kind).toBe('reset');
  });

  it('updates the last bar when only it changed', () => {
    const s1 = applyTick(s0, { time: 1075, price: 5000 });
    const plan = planRender(s0.bars, s1.bars);
    expect(plan).toEqual({ kind: 'update', bar: s1.bars[1] });
  });

  it('updates when exactly one bar was appended', () => {
    const s1 = applyTick(s0, { time: 1125, price: 7 });
    expect(planRender(s0.bars, s1.bars)).toEqual({ kind: 'update', bar: s1.bars[2] });
  });

  it('RESETS when a bar was appended AND an earlier bar was corrected', () => {
    // The silent data-loss bug: the old length-delta heuristic saw "+1 bar" and
    // pushed only the appended bar, so the correction to the earlier bar never
    // reached the canvas. React state and the canvas then disagreed forever.
    const s1 = applyRealBars(s0, [real(1060, { high: 99_999 }), real(1120)]);
    expect(planRender(s0.bars, s1.bars).kind).toBe('reset');
  });

  it('RESETS on a prepend (bars added at the front)', () => {
    const { series } = prependBars(s0, [real(940)]);
    expect(planRender(s0.bars, series.bars).kind).toBe('reset');
  });

  it('RESETS when the series shrank', () => {
    expect(planRender(s0.bars, s0.bars.slice(0, 1)).kind).toBe('reset');
  });
});
