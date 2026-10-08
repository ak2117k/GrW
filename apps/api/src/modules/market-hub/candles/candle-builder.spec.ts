import type { InstrumentRef, Price } from '../hub.types';
import { CandleBuilder } from './candle-builder';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' };
const p = (at: string, ltp: number, volume?: number, extra: Partial<Price> = {}): Price => ({
  ref: NIFTY, ltp, at: ist(at), source: 'ws', volume, ...extra,
});

describe('CandleBuilder', () => {
  it('builds OHLC within a minute and closes it on the next minute’s tick', () => {
    const b = new CandleBuilder();
    expect(b.onPrice(p('2026-10-07T10:00:05', 100))).toEqual([]);
    b.onPrice(p('2026-10-07T10:00:20', 103));
    b.onPrice(p('2026-10-07T10:00:40', 99));
    b.onPrice(p('2026-10-07T10:00:59', 101));
    const closed = b.onPrice(p('2026-10-07T10:01:01', 102));
    expect(closed).toEqual([
      { ref: NIFTY, candle: { ts: ist('2026-10-07T10:00:00'), open: 100, high: 103, low: 99, close: 101, volume: 0 } },
    ]);
    expect(b.stats().building).toBe(1);
  });

  it('first tick of the day only sets the baseline; volume is the difference after that', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:00:05', 100, 1_000_000)); // hub (re)started mid-session: baseline
    b.onPrice(p('2026-10-07T10:00:30', 100, 1_000_200));
    b.onPrice(p('2026-10-07T10:00:50', 100, 1_000_500));
    const [bar] = b.onPrice(p('2026-10-07T10:01:10', 100, 1_000_600));
    expect(bar.candle.volume).toBe(500);
    const [next] = b.closeDue(ist('2026-10-07T10:02:03'));
    expect(next.candle.volume).toBe(100);
  });

  it('a new day re-baselines the cumulative volume', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T15:29:10', 100, 9_000));
    b.onPrice(p('2026-10-07T15:29:40', 100, 9_500));
    // Lower: next day's running total. This tick also closes yesterday's last bar.
    const [yesterday] = b.onPrice(p('2026-10-08T09:15:05', 100, 40));
    const [today] = b.closeDue(ist('2026-10-08T09:16:05'));
    expect(yesterday.candle.volume).toBe(500);
    expect(today.candle.volume).toBe(0);
  });

  it('closeDue closes a quiet bar only after its minute plus the grace period', () => {
    const b = new CandleBuilder(2000);
    b.onPrice(p('2026-10-07T10:00:05', 100));
    expect(b.closeDue(ist('2026-10-07T10:01:01'))).toEqual([]);
    expect(b.closeDue(ist('2026-10-07T10:01:02'))).toHaveLength(1);
    expect(b.stats().building).toBe(0);
  });

  it('ignores a late tick for an already-closed minute and counts it', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:01:05', 100));
    expect(b.onPrice(p('2026-10-07T10:00:59', 50))).toEqual([]);
    const [bar] = b.closeDue(ist('2026-10-07T10:03:00'));
    expect(bar.candle.low).toBe(100);
    expect(b.stats().lateTicks).toBe(1);
  });

  it('ignores non-positive prices and keeps the last open interest', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:00:05', 0));
    b.onPrice(p('2026-10-07T10:00:10', 100, undefined, { oi: 10 }));
    b.onPrice(p('2026-10-07T10:00:20', 101, undefined, { oi: 12 }));
    const [bar] = b.closeDue(ist('2026-10-07T10:02:00'));
    expect(bar.candle).toMatchObject({ open: 100, oi: 12 });
  });

  it('keeps the same token on two exchanges apart', () => {
    const b = new CandleBuilder();
    const mcx: InstrumentRef = { exchange: 'MCX', token: '99926000', symbol: 'X' };
    b.onPrice(p('2026-10-07T10:00:05', 100));
    b.onPrice({ ref: mcx, ltp: 7, at: ist('2026-10-07T10:00:06'), source: 'ws' });
    expect(b.closeDue(ist('2026-10-07T10:02:00')).map((c) => c.ref.exchange).sort()).toEqual(['MCX', 'NSE']);
  });
});
