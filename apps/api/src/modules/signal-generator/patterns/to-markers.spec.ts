import { buildPatternMarkers } from './to-markers';
import type { Candle } from './swing-points';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

/**
 * Build candles from parallel OHLC arrays. `time` is set to `(i + 1) * 60000`
 * (epoch-ms-like, distinct from the index) so the tests prove markers carry the
 * candle's `time` — NOT its array index.
 */
function series(
  highs: number[],
  lows: number[],
  opens: number[],
  closes: number[],
): Candle[] {
  return highs.map((h, i) => ({
    time: (i + 1) * 60000,
    high: h,
    low: lows[i],
    open: opens[i],
    close: closes[i],
  }));
}

const ms = (index: number) => (index + 1) * 60000;

describe('buildPatternMarkers', () => {
  // A clean double TOP at default strength 3: equal peaks (110) at idx 4 & 12,
  // valley (90) at idx 8. idx 13 closes at 85 (< neckline 90) ⇒ confirmed break.
  const TOP_HIGHS = [100, 101, 102, 103, 110, 103, 102, 101, 95, 101, 102, 103, 110, 103, 102, 101];
  const TOP_LOWS = [98, 99, 100, 101, 108, 100, 98, 96, 90, 96, 98, 100, 108, 101, 100, 99];

  it('maps a confirmed double top to a CHART marker with time/points/neckline in ms', () => {
    // Closes mirror lows so midpoints don't break the neckline, EXCEPT idx 13
    // which closes at 85 to confirm the breakdown.
    const closes = [...TOP_LOWS];
    closes[13] = 85;
    // Opens = highs so each candle has a real body (opens/closes irrelevant to
    // swing detection here; they only feed neckline confirmation via close).
    const candles = series(TOP_HIGHS, TOP_LOWS, [...TOP_HIGHS], closes);

    const markers = buildPatternMarkers(candles);
    const chart = markers.filter((m) => m.category === 'CHART');
    expect(chart).toHaveLength(1);

    const m = chart[0];
    expect(m).toMatchObject<Partial<PatternMarkerDto>>({
      category: 'CHART',
      name: 'DOUBLE_TOP',
      bias: 'BEARISH',
      // Anchor = SECOND peak (idx 12).
      time: ms(12),
      // [firstPeakMs, secondPeakMs] = idx 4 & 12.
      points: [ms(4), ms(12)],
      necklinePrice: 90,
      confirmed: true,
      confirmTime: ms(13),
    });
  });

  it('maps a hammer to a CANDLESTICK marker with empty points and null chart fields', () => {
    // Flat filler candles (no pattern) then a single hammer at the last index:
    // long lower wick, tiny upper wick, small real body.
    const n = 30;
    const candles: Candle[] = [];
    for (let i = 0; i < n; i++) {
      candles.push({ time: (i + 1) * 60000, open: 100, high: 100.2, low: 99.8, close: 100 });
    }
    // Hammer at the last index: open 100, close 100.5 (body 0.5), low 96
    // (lower wick 4 >= 2*body), high 100.6 (upper wick 0.1 <= 1*body).
    const hIdx = n - 1;
    candles[hIdx] = { time: (hIdx + 1) * 60000, open: 100, high: 100.6, low: 96, close: 100.5 };

    const markers = buildPatternMarkers(candles);
    const hammer = markers.find((m) => m.name === 'HAMMER');
    expect(hammer).toBeDefined();
    expect(hammer).toMatchObject<Partial<PatternMarkerDto>>({
      category: 'CANDLESTICK',
      name: 'HAMMER',
      bias: 'BULLISH',
      time: ms(hIdx),
      points: [],
      necklinePrice: null,
      confirmed: null,
      confirmTime: null,
    });
  });

  it('detects both a CHART and a CANDLESTICK marker in one series', () => {
    // Midpoint opens/closes ⇒ zero-body candles register as DOJI candlestick
    // hits, while the high/low geometry still traces the double top.
    const mids = TOP_HIGHS.map((h, i) => (h + TOP_LOWS[i]) / 2);
    const closes = [...mids];
    closes[13] = 85; // confirms the double-top breakdown (close < neckline 90)
    const candles = series(TOP_HIGHS, TOP_LOWS, mids, closes);

    const markers = buildPatternMarkers(candles);
    expect(markers.some((m) => m.category === 'CHART' && m.name === 'DOUBLE_TOP')).toBe(true);
    expect(markers.some((m) => m.category === 'CANDLESTICK')).toBe(true);
  });
});
