import { MAX_TICK_GAP_MS, TickBarBuilder, type TickBar } from './tick-bars';

// 2026-10-23 13:30:00 IST = 08:00:00 UTC.
const T0 = Date.parse('2026-10-23T08:00:00Z');
const s = (sec: number) => T0 + sec * 1000;

/** Ticks every `step` seconds from `from` to `to` (inclusive) for NIFTY at `price(sec)`. */
function feed(b: TickBarBuilder, from: number, to: number, price: (sec: number) => number, step = 1) {
  const out: TickBar[] = [];
  for (let sec = from; sec <= to; sec += step) out.push(...b.onTick('NIFTY', price(sec), s(sec)));
  return out;
}

describe('TickBarBuilder', () => {
  it('emits a complete minute with its OHLC once a later tick closes it', () => {
    const b = new TickBarBuilder(['NIFTY', 'INDIAVIX']);
    feed(b, -5, -1, () => 25_000); // primed in the previous minute
    const out = feed(b, 0, 60, (sec) => (sec === 60 ? 25_050 : 25_000 + (sec === 20 ? 40 : sec === 40 ? -30 : sec / 10)));
    expect(out).toHaveLength(1); // 13:29 was not primed (its first tick is the first seen) → dropped
    const bar = out.find((x) => x.bar.timestamp.getTime() === T0);
    expect(bar).toEqual({
      series: 'NIFTY',
      bar: { timestamp: new Date(T0), open: 25_000, high: 25_040, low: 24_970, close: 25_000 + 59 / 10, volume: 0 },
    });
  });

  it('never emits the first minute it sees (its opening value is unknown)', () => {
    const b = new TickBarBuilder(['NIFTY']);
    const out = feed(b, 10, 61, () => 25_000);
    expect(out).toEqual([]);
  });

  it('a gap in the stream longer than MAX_TICK_GAP_MS drops the minutes it touches, then recovers', () => {
    const b = new TickBarBuilder(['NIFTY']);
    feed(b, -5, 10, () => 25_000);
    const gapEnd = 10 + MAX_TICK_GAP_MS / 1000 + 5; // 30 s
    const out = [...feed(b, gapEnd, 125, () => 25_000)];
    const minutes = out.map((x) => (x.bar.timestamp.getTime() - T0) / 60_000);
    expect(minutes).toEqual([1]); // 13:30 hit by the gap; 13:31 complete; 13:32 not closed yet
  });

  it('a quiet series on a live socket still makes complete bars (heartbeat from other tokens)', () => {
    const b = new TickBarBuilder(['NIFTY', 'INDIAVIX']);
    b.onTick('INDIAVIX', 14.1, s(-30));
    const out: TickBar[] = [];
    for (let sec = -29; sec <= 61; sec++) out.push(...b.onTick(null, 0, s(sec))); // other tokens tick
    out.push(...b.onTick('INDIAVIX', 14.2, s(30))); // late: stream clock already at :61
    expect(out).toEqual([]); // VIX had no tick inside 13:30 → no bar
    b.onTick('INDIAVIX', 14.3, s(65));
    const more: TickBar[] = [];
    for (let sec = 66; sec <= 121; sec++) more.push(...b.onTick(null, 0, s(sec)));
    expect(more).toEqual([{ series: 'INDIAVIX', bar: { timestamp: new Date(T0 + 60_000), open: 14.3, high: 14.3, low: 14.3, close: 14.3, volume: 0 } }]);
  });

  it('reset() (socket dropped) makes everything in flight incomplete', () => {
    const b = new TickBarBuilder(['NIFTY']);
    feed(b, -5, 30, () => 25_000);
    b.reset();
    expect(feed(b, 31, 125, () => 25_000).map((x) => x.bar.timestamp.getTime() - T0)).toEqual([60_000]);
  });

  it('only emits minutes inside the 09:15–15:30 IST session', () => {
    const b = new TickBarBuilder(['NIFTY']);
    const close = Date.parse('2026-10-23T10:00:00Z') - 60_000; // 15:29 IST
    const out: TickBar[] = [];
    for (let t = close - 10_000; t <= close + 125_000; t += 1000) out.push(...b.onTick('NIFTY', 25_000, t));
    expect(out.map((x) => x.bar.timestamp.toISOString())).toEqual(['2026-10-23T09:59:00.000Z']);
  });

  it('ignores non-positive or non-finite prices and timestamps', () => {
    const b = new TickBarBuilder(['NIFTY']);
    expect(b.onTick('NIFTY', NaN, s(0))).toEqual([]);
    expect(b.onTick('NIFTY', 0, s(1))).toEqual([]);
    expect(b.onTick('NIFTY', 25_000, NaN)).toEqual([]);
  });
});
