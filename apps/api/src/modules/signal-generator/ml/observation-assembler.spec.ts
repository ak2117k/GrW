import { buildObservationInputs } from './observation-assembler';
import type { OhlcvCandle } from './pattern-observation.types';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

function bar(time: number, o: number, h: number, l: number, c: number): OhlcvCandle {
  return { time, open: o, high: h, low: l, close: c, volume: 100 };
}

describe('buildObservationInputs', () => {
  // 30 flat candles, with a bullish marker anchored at index 15.
  // The counts are load-bearing: 16 candles up to the anchor > atrPeriod 14, so ATR
  // resolves to 2 rather than 0; and the full n=10 horizon (bars 16-25) fits inside
  // the 30, so the outcome is a definite TIMEOUT rather than PENDING.
  const candles: OhlcvCandle[] = Array.from({ length: 30 }, (_, i) =>
    bar(i * 1000, 100, 101, 99, 100),
  );

  const bullMarker: PatternMarkerDto = {
    category: 'CANDLESTICK', name: 'HAMMER', bias: 'BULLISH',
    time: 15 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
  };
  const neutralMarker: PatternMarkerDto = {
    category: 'CANDLESTICK', name: 'DOJI', bias: 'NEUTRAL',
    time: 15 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
  };

  const meta = { token: '2885', exchange: 'NSE', timeframe: '15m' };

  it('produces one observation per non-neutral marker, tagged with timeframe', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].timeframe).toBe('15m');
    expect(out[0].token).toBe('2885');
    expect(out[0].patternName).toBe('HAMMER');
    expect(out[0].bias).toBe('BULLISH');
    expect(out[0].barTime.getTime()).toBe(15 * 1000);
  });

  it('window is the last `windowBars` candles up to & including the anchor', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out[0].candleWindow).toHaveLength(10);
    expect(out[0].candleWindow[9].time).toBe(15 * 1000); // last = anchor
    expect(out[0].candleWindow[0].time).toBe(6 * 1000); // 15-10+1 = index 6
  });

  it('skips NEUTRAL-bias markers (no follow-through direction)', () => {
    const out = buildObservationInputs(candles, [neutralMarker], meta);
    expect(out).toHaveLength(0);
  });

  it('computes an outcome and a numeric ATR', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out[0].outcome).toBe('TIMEOUT');
    expect(out[0].label).toBeNull();
    expect(out[0].atrAtDetection).toBeCloseTo(2);
  });

  it('drops a marker whose time has no matching candle', () => {
    const orphan: PatternMarkerDto = { ...bullMarker, time: 99999999 };
    const out = buildObservationInputs(candles, [orphan], meta);
    expect(out).toHaveLength(0);
  });
});
