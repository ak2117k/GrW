import { describe, it, expect } from 'vitest';
import { seriesReducer, type SeriesState } from './useChartData';
import { emptySeries, type RealBar } from '@/utils/chartSeries';

const TF = 900; // 15m bars, in seconds

function bar(time: number, close = 100): RealBar {
  return { time, open: 100, high: 101, low: 99, close, volume: 10 };
}

function initial(tfSec = TF): SeriesState {
  return { epoch: 1, series: emptySeries(tfSec), prependSeq: 0 };
}

/** Load a contiguous 15m series so the state has something to race against. */
function loaded(epoch = 1): SeriesState {
  return seriesReducer(initial(), {
    type: 'load',
    epoch,
    bars: [bar(9000), bar(9900), bar(10800)],
  });
}

describe('seriesReducer — epoch guards', () => {
  it('drops a fetch response that lands after a symbol/timeframe switch', () => {
    // The old code had a fetchId guard here but NOT on the live-edge poll,
    // which is how an in-flight 15m batch merged into a freshly-selected 1H
    // series (and how the previous symbol's bars landed on the new symbol).
    const s0 = initial();
    const switched = seriesReducer(s0, { type: 'reset', epoch: 2, tfSec: 3600 });
    const after = seriesReducer(switched, {
      type: 'load',
      epoch: 1, // issued before the switch
      bars: [bar(9000), bar(9900)],
    });
    expect(after).toBe(switched);
    expect(after.series.bars).toHaveLength(0);
    expect(after.series.tfSec).toBe(3600);
  });

  it('drops a stale live-edge poll batch', () => {
    const s = loaded();
    const switched = seriesReducer(s, { type: 'reset', epoch: 2, tfSec: TF });
    const next = seriesReducer(switched, { type: 'rest', epoch: 1, bars: [bar(11700)] });
    expect(next).toBe(switched);
  });

  it('drops stale ticks and stale prepends', () => {
    const s = loaded();
    const switched = seriesReducer(s, { type: 'reset', epoch: 2, tfSec: TF });
    expect(
      seriesReducer(switched, { type: 'tick', epoch: 1, tick: { time: 11_000, price: 5 } }),
    ).toBe(switched);
    expect(seriesReducer(switched, { type: 'prepend', epoch: 1, bars: [bar(8100)] })).toBe(
      switched,
    );
  });

  it('accepts everything issued under the current epoch', () => {
    const s = loaded();
    expect(s.series.bars).toHaveLength(3);
    const ticked = seriesReducer(s, { type: 'tick', epoch: 1, tick: { time: 11_000, price: 555 } });
    expect(ticked.series.bars[2].close).toBe(555);
    const polled = seriesReducer(ticked, { type: 'rest', epoch: 1, bars: [bar(11_700)] });
    expect(polled.series.bars).toHaveLength(4);
  });
});

describe('seriesReducer — reset semantics', () => {
  it('clears the bars and adopts the new timeframe', () => {
    const s = seriesReducer(loaded(), { type: 'reset', epoch: 5, tfSec: 3600 });
    expect(s.series.bars).toEqual([]);
    expect(s.series.tfSec).toBe(3600);
    expect(s.epoch).toBe(5);
  });

  it('does NOT reset prependSeq — the chart reads a bump as "preserve scroll"', () => {
    // A symbol switch must read as a full reset to the chart, so prependSeq
    // has to stay put rather than change and be mistaken for a prepend.
    const withPrepend = seriesReducer(loaded(), {
      type: 'prepend',
      epoch: 1,
      bars: [bar(8100)],
    });
    expect(withPrepend.prependSeq).toBe(1);
    const reset = seriesReducer(withPrepend, { type: 'reset', epoch: 2, tfSec: TF });
    expect(reset.prependSeq).toBe(1);
  });
});

describe('seriesReducer — referential stability', () => {
  it('returns the same state object when an action changes nothing', () => {
    // Every no-op that returns `state` avoids a re-render, and lets the
    // chart's reference diff conclude "nothing to draw".
    const s = loaded();
    expect(seriesReducer(s, { type: 'tick', epoch: 1, tick: { time: 500, price: 5 } })).toBe(s);
    expect(seriesReducer(s, { type: 'rest', epoch: 1, bars: [] })).toBe(s);
    expect(seriesReducer(s, { type: 'prepend', epoch: 1, bars: [] })).toBe(s);
  });

  it('bumps prependSeq only when bars were actually prepended', () => {
    const s = loaded();
    const noop = seriesReducer(s, { type: 'prepend', epoch: 1, bars: [bar(10_800)] });
    expect(noop.prependSeq).toBe(0);
    const real = seriesReducer(s, { type: 'prepend', epoch: 1, bars: [bar(8100)] });
    expect(real.prependSeq).toBe(1);
    expect(real.series.bars).toHaveLength(4);
  });
});

describe('seriesReducer — tick and poll compose without duplicating a bar', () => {
  it('a tick opens the next bar and the poll then corrects it in place', () => {
    // The two writers used to each maintain their own "current bucket" cursor,
    // so they could both append for the same bucket. The cursor is now derived
    // from the bars themselves, so this is structurally impossible.
    const s = loaded();
    const ticked = seriesReducer(s, {
      type: 'tick',
      epoch: 1,
      tick: { time: 11_700 + 5, price: 250 },
    });
    expect(ticked.series.bars).toHaveLength(4);
    expect(ticked.series.bars[3].realTime).toBe(11_700);

    const polled = seriesReducer(ticked, {
      type: 'rest',
      epoch: 1,
      bars: [bar(10_800), { ...bar(11_700), open: 123 }],
    });
    expect(polled.series.bars).toHaveLength(4); // not 5
    expect(polled.series.bars[3].open).toBe(123); // broker owns the open
    expect(polled.series.bars[3].close).toBe(250); // tick owns the close
  });
});
