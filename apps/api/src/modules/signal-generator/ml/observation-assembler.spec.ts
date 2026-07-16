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

describe('buildObservationInputs — CHART detection lag', () => {
  // The fixture is built so the shift CHANGES THE ANSWER; that contrast is the test.
  //
  // 40 quiet candles (TR = 1 each ⇒ ATR = 1) with ONE event: at index 21 price
  // wicks down to 98 and closes straight back at 100. Nothing else ever moves.
  //
  // A BEARISH marker anchored at index 20:
  //   - labelled from the ANCHOR (20): entry 100, ATR 1 ⇒ favorable 100-1.5 = 98.5.
  //     Bar 21's low of 98 reaches it ⇒ WIN.
  //   - labelled from the DECISION bar (20+3 = 23): entry is still close[23] = 100,
  //     but bar 21 is now in the PAST. Bars 24-33 never leave 99.5/100.5 ⇒ TIMEOUT.
  //
  // That is the bug in miniature: the whole favorable move happened inside the 3
  // bars spent DETECTING the pattern, so a trader who could not see the pattern
  // until bar 23 captured none of it. Anchor-labelling books it as a WIN anyway.
  // 40 candles keeps the full n=10 horizon from the decision bar (23+10 = 33 <= 39)
  // inside the series, so the shifted outcome is a definite TIMEOUT, not PENDING.
  const quiet = (t: number) => bar(t * 1000, 100, 100.5, 99.5, 100);
  const candles: OhlcvCandle[] = Array.from({ length: 40 }, (_, i) =>
    i === 21 ? bar(21 * 1000, 100, 100.5, 98, 100) : quiet(i),
  );

  const meta = { token: '2885', exchange: 'NSE', timeframe: '15m' };

  const chartMarker: PatternMarkerDto = {
    category: 'CHART', name: 'DOUBLE_TOP', bias: 'BEARISH',
    time: 20 * 1000, points: [12 * 1000, 20 * 1000],
    necklinePrice: 99.5, confirmed: false, confirmTime: null,
  };
  // Same bar, same direction — only the category differs.
  const candleMarker: PatternMarkerDto = {
    category: 'CANDLESTICK', name: 'SHOOTING_STAR', bias: 'BEARISH',
    time: 20 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
  };

  it('labels a CHART pattern from the bar it becomes detectable, not its anchor', () => {
    const [obs] = buildObservationInputs(candles, [chartMarker], meta);
    // Bar 21's favorable spike is spent detecting the pattern — it must NOT count.
    expect(obs.outcome).toBe('TIMEOUT');
    expect(obs.label).toBeNull();
  });

  it('does NOT shift CANDLESTICK patterns — same bar, same bias, WIN', () => {
    const [obs] = buildObservationInputs(candles, [candleMarker], meta);
    // A shooting star at bar 20 IS knowable at bar 20's close, so bar 21 is
    // genuinely tradeable follow-through. This is the control: it pins the
    // contrast to the CHART shift and nothing else.
    expect(obs.outcome).toBe('WIN');
    expect(obs.label).toBe(1);
  });

  it('keeps barTime at the anchor — it is the row identity, not the decision bar', () => {
    const [obs] = buildObservationInputs(candles, [chartMarker], meta);
    expect(obs.barTime.getTime()).toBe(20 * 1000); // NOT 23 * 1000
    expect(obs.patternName).toBe('DOUBLE_TOP');
    expect(obs.category).toBe('CHART');
  });

  it('computes atrAtDetection at the decision bar, so it sees bar 21s spike', () => {
    const [chart] = buildObservationInputs(candles, [chartMarker], meta);
    const [cs] = buildObservationInputs(candles, [candleMarker], meta);
    // ATR at bar 20 has only quiet TR=1 bars behind it.
    expect(cs.atrAtDetection).toBeCloseTo(1, 6);
    // ATR at bar 23 has absorbed bar 21's TR of 2.5 via Wilder smoothing.
    expect(chart.atrAtDetection).toBeCloseTo(1.0923833819241983, 6);
    expect(chart.atrAtDetection).toBeGreaterThan(cs.atrAtDetection);
  });

  it('ends the CHART candleWindow at the decision bar', () => {
    const [obs] = buildObservationInputs(candles, [chartMarker], meta, { windowBars: 10 });
    expect(obs.candleWindow).toHaveLength(10);
    expect(obs.candleWindow[9].time).toBe(23 * 1000); // decision bar, not the anchor
    expect(obs.candleWindow[0].time).toBe(14 * 1000); // 23-10+1
  });

  it('drops a CHART marker whose decision bar lies past the end of the series', () => {
    // Anchor at 38 ⇒ decision bar 41, but the series ends at 39: not knowable yet,
    // and no bar to price the entry from.
    const tooLate: PatternMarkerDto = { ...chartMarker, time: 38 * 1000 };
    expect(buildObservationInputs(candles, [tooLate], meta)).toHaveLength(0);
    // The same anchor as a CANDLESTICK is still perfectly assemblable.
    expect(
      buildObservationInputs(candles, [{ ...candleMarker, time: 38 * 1000 }], meta),
    ).toHaveLength(1);
  });
});
