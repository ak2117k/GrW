import {
  body,
  range,
  upperWick,
  lowerWick,
  detectEngulfing,
  detectHammerOrStar,
  detectDoji,
  findCandlestickPatterns,
  type CandlestickPattern,
} from './candlestick';
import { type Candle } from './swing-points';

/** Build a candle from explicit OHLC; `time` defaults to the given index. */
function mk(open: number, high: number, low: number, close: number, index = 0): Candle {
  return { time: index, open, high, low, close };
}

describe('candlestick geometry helpers', () => {
  it('computes body/range/upperWick/lowerWick on a known candle', () => {
    // open 10, high 16, low 8, close 14 → body 4, range 8, wicks 2 & 2.
    const c = mk(10, 16, 8, 14);
    expect(body(c)).toBe(4);
    expect(range(c)).toBe(8);
    expect(upperWick(c)).toBe(2);
    expect(lowerWick(c)).toBe(2);
  });
});

describe('detectEngulfing', () => {
  it('detects a bullish engulfing (down bar swallowed by a bigger up bar)', () => {
    const prev = mk(10, 10.3, 7.7, 8); // bearish, body 2
    const curr = mk(7, 11.2, 6.9, 11, 1); // bullish, body 4, spans prev body
    expect(detectEngulfing(prev, curr, 1)).toEqual<CandlestickPattern>({
      name: 'BULLISH_ENGULFING',
      index: 1,
      time: 1,
      bias: 'BULLISH',
    });
  });

  it('detects a bearish engulfing (up bar swallowed by a bigger down bar)', () => {
    const prev = mk(8, 10.3, 7.7, 10); // bullish, body 2
    const curr = mk(11, 11.3, 6.8, 7, 1); // bearish, body 4, spans prev body
    expect(detectEngulfing(prev, curr, 1)).toEqual<CandlestickPattern>({
      name: 'BEARISH_ENGULFING',
      index: 1,
      time: 1,
      bias: 'BEARISH',
    });
  });

  it('returns null when curr body is smaller than prev (no engulf)', () => {
    const prev = mk(12, 12.3, 5.7, 6); // bearish, body 6
    const curr = mk(8, 9.2, 7.8, 9, 1); // bullish, body 1, sits inside prev
    expect(detectEngulfing(prev, curr, 1)).toBeNull();
  });
});

describe('detectHammerOrStar', () => {
  it('detects a hammer (long lower wick, tiny upper wick, real body)', () => {
    // body 1, lower wick 5 (>= 2*body), upper wick 0.2 (<= 1*body).
    const c = mk(10, 11.2, 5, 11);
    expect(detectHammerOrStar(c, 0)).toEqual<CandlestickPattern>({
      name: 'HAMMER',
      index: 0,
      time: 0,
      bias: 'BULLISH',
    });
  });

  it('detects a shooting star (long upper wick, tiny lower wick)', () => {
    // body 1, upper wick 5 (>= 2*body), lower wick 0.2 (<= 1*body).
    const c = mk(10, 15, 8.8, 9);
    expect(detectHammerOrStar(c, 0)).toEqual<CandlestickPattern>({
      name: 'SHOOTING_STAR',
      index: 0,
      time: 0,
      bias: 'BEARISH',
    });
  });

  it('returns null for a zero-body bar (doji territory, not a hammer)', () => {
    const c = mk(10, 14, 6, 10); // body 0
    expect(detectHammerOrStar(c, 0)).toBeNull();
  });
});

describe('detectDoji', () => {
  it('detects a doji (tiny body vs range)', () => {
    // range 4, body 0.05 (<= 0.1 * range).
    const c = mk(10, 12, 8, 10.05);
    expect(detectDoji(c, 0)).toEqual<CandlestickPattern>({
      name: 'DOJI',
      index: 0,
      time: 0,
      bias: 'NEUTRAL',
    });
  });

  it('does NOT flag a normal candle as a doji', () => {
    // range 4, body 3 (well above 0.1 * range).
    const c = mk(10, 13.5, 9.5, 13);
    expect(detectDoji(c, 0)).toBeNull();
  });
});

describe('findCandlestickPatterns (whole-series scan)', () => {
  it('returns every pattern, ordered by index ascending', () => {
    const candles: Candle[] = [
      mk(5, 6.2, 4.8, 6, 0), // filler — no pattern
      mk(10, 10.3, 7.7, 8, 1), // bearish (prev of the engulf)
      mk(7, 11.2, 6.9, 11, 2), // bullish engulfing → BULLISH_ENGULFING @2
      mk(20, 22, 18, 20.1, 3), // doji → DOJI @3
      mk(30, 31.2, 26, 31, 4), // hammer → HAMMER @4
    ];

    const hits = findCandlestickPatterns(candles);
    expect(hits.map((h) => [h.name, h.index])).toEqual([
      ['BULLISH_ENGULFING', 2],
      ['DOJI', 3],
      ['HAMMER', 4],
    ]);
  });
});
