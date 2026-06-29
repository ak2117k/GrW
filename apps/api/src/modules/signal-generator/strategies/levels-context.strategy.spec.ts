// levels-context.strategy.spec.ts
import { LevelsContextStrategy } from './levels-context.strategy';
import { LevelBook } from '../types/level-book.types';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';
import type { StrongZone } from '../types/zone.types';

describe('LevelsContextStrategy.analyze', () => {
  let strategy: LevelsContextStrategy;
  beforeEach(() => {
    strategy = new LevelsContextStrategy();
    // These fixtures put the trigger candle at the END of the array
    // (length-1). Production defaults to evaluating against the last
    // CLOSED bar (length-2), so opt back into legacy mode for tests.
    strategy.setParameters({ evaluateOnLastBar: true });
  });

  // Build N 5-min candles ending at a target close. ATR/volume are configurable.
  const buildCandles = (count: number, opts: {
    closes?: number[]; volumes?: number[];
    open?: number; high?: number; low?: number;
  }): CandleData[] => {
    const candles: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      const close = opts.closes?.[i] ?? 24100;
      const volume = opts.volumes?.[i] ?? 100_000;
      candles.push({
        timestamp: new Date(`2026-04-27T10:${String(i).padStart(2, '0')}:00+05:30`),
        open: opts.open ?? close - 5,
        high: opts.high ?? close + 10,
        low: opts.low ?? close - 10,
        close,
        volume,
      });
    }
    return candles;
  };

  const baseLevelBook = (overrides?: Partial<LevelBook>): LevelBook => ({
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    asOf: new Date(),
    pdh: 24180,
    pdl: 23950,
    prevClose: 24100,
    orh: 24160,
    orl: 24080,
    orLocked: true,
    prevOrh: null,
    prevOrl: null,
    spot: 24100,
    vwap: 24090,
    todayHigh: 24160,
    todayLow: 24050,
    atr14: 100,
    lastTickAt: new Date(),
    roundNumbers: [24000, 24050, 24100, 24150, 24200],
    ...overrides,
  });

  // ---- Distance gate ----
  it('returns null when spot is too far from every level', () => {
    const book = baseLevelBook({ spot: 24500 });
    const candles = buildCandles(25, { closes: Array(25).fill(24500) });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Time-of-day gate ----
  it('returns null when current time is in midday chop window', () => {
    const book = baseLevelBook();
    // Last close right at PDH 24180 with volume spike — would normally fire
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '12:30' })).toBeNull();
  });

  // ---- Stale level book ----
  it('returns null when level book is stale (lastTickAt > 60s old)', () => {
    const book = baseLevelBook({ lastTickAt: new Date(Date.now() - 90_000) });
    const candles = buildCandles(25, { closes: [...Array(24).fill(24100), 24185] });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Breakout pass ----
  it('emits BREAKOUT signal when 5m close > level + 0.15·ATR with volume confirm', () => {
    const book = baseLevelBook({ spot: 24190 });
    // 24 filler bars + explicit trigger candle whose close (24197) is strictly
    // above PDH+0.15·ATR (24180+15=24195). Tight upper wick (high=24199) keeps
    // upperWick/range = 2/12 = 0.17 < BREAKOUT_WICK_MAX_RATIO(0.3).
    const filler = buildCandles(24, {
      closes: Array(24).fill(24100),
      volumes: [...Array(20).fill(100_000), ...Array(4).fill(200_000)],
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:24:00+05:30'),
      open: 24192, high: 24199, low: 24187, close: 24197, volume: 200_000,
    };
    const candles = [...filler, trigger];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('BREAKOUT');
    expect(out!.metadata!.levelType).toBe('PDH');
    expect(out!.side).toBe('BUY');
  });

  // ---- Reversal pass ----
  it('emits REVERSAL signal on pinbar rejection at PDH', () => {
    const book = baseLevelBook({ spot: 24165 });
    // Pinbar candle: long upper wick into PDH(24180), close near low
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160,
      high: 24182,    // wick into PDH
      low: 24150,
      close: 24158,   // body small + back below level
      volume: 130_000,
    };
    const earlier = buildCandles(24, { closes: Array(24).fill(24160), volumes: Array(24).fill(100_000) });
    const candles = [...earlier, lastCandle];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('REVERSAL');
    expect(out!.side).toBe('SELL'); // rejection at resistance → short bias
  });

  // ---- R:R fail ----
  it('returns null when R:R math fails (target < 2× SL)', () => {
    // PDH=24180, spot=24179, no other levels nearby — target distance too small
    const book = baseLevelBook({
      spot: 24179, pdh: 24180,
      orh: 24210,   // very close — would make target < 2×SL
      orl: 23950, vwap: 24179, todayHigh: 24179, todayLow: 24050,
      atr14: 50,    // tiny ATR exaggerates the issue
      roundNumbers: [],
    });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24178), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Volume gate fail ----
  it('returns null when breakout candle volume < 1.2× VMA20', () => {
    const book = baseLevelBook({ spot: 24190 });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      // No volume spike on the trigger candle
      volumes: Array(25).fill(100_000),
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Grade A: confluence ----
  it('grades A when level is in confluence with another level (within 0.1·ATR)', () => {
    // PDH 24180 + round number 24180 in confluence; spot interacts with PDH.
    // Trigger close 24197 > PDH+0.15·ATR(24195). Tight upper wick passes wick gate.
    const book = baseLevelBook({
      spot: 24190,
      pdh: 24180,
      roundNumbers: [24150, 24180, 24200, 24250],
    });
    const filler = buildCandles(24, {
      closes: Array(24).fill(24100),
      volumes: [...Array(20).fill(100_000), ...Array(4).fill(160_000)],
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:24:00+05:30'),
      open: 24192, high: 24199, low: 24187, close: 24197, volume: 160_000,
    };
    const candles = [...filler, trigger];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('A');
  });

  // ---- Indicator confluence: bullish boost upgrades grade ----
  it('upgrades grade when indicators align bullish on a BUY breakout', () => {
    // 40 closes with a steady uptrend mixed with small pullbacks so RSI
    // lands in the (50, 70) trend-zone rather than getting stretched
    // toward 100. MACD needs 35+ closes (slow=26 + signal=9) to render
    // a non-null histogram. Volume spikes only on the trigger candle so
    // the base grade is B (no prime-window confluence boost).
    const closes: number[] = [];
    let v = 24050;
    for (let i = 0; i < 39; i++) {
      // net-positive drift with alternating small pullbacks
      v += i % 2 === 0 ? 4 : -1;
      closes.push(v);
    }
    // Trigger close 24197 > PDH+0.15·ATR(24195). Tight upper wick (high=24199)
    // keeps upperWick/range = 2/12 = 0.17 < BREAKOUT_WICK_MAX_RATIO(0.3).
    const book = baseLevelBook({
      spot: 24197,
      pdh: 24180,
      roundNumbers: [24000, 24050, 24100],
    });
    const filler = buildCandles(39, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(4).fill(150_000)],
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:39:00+05:30'),
      open: 24192, high: 24199, low: 24187, close: 24197, volume: 150_000,
    };
    const candles = [...filler, trigger];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '11:00' });
    expect(out).not.toBeNull();
    const meta = out!.metadata as { indicators: { agreement: number }; grade: string };
    expect(meta.indicators.agreement).toBeGreaterThanOrEqual(4);
    expect(meta.grade).toBe('A');
  });

  // ---- Indicator confluence: bearish opposition demotes grade ----
  it('demotes grade when indicators oppose a BUY breakout', () => {
    // Strongly descending 40-bar series, then a single high-volume spike
    // candle that closes just above PDH — the breakout fires, but every
    // indicator opposes it. Base grade (volume + confluence + prime
    // window) would be A → demoted by the agreement penalty.
    const closes: number[] = [];
    for (let i = 0; i < 39; i++) closes.push(24600 - i * 5); // 24600 → 24410
    const book = baseLevelBook({
      spot: 24397,
      pdh: 24380,
      orh: 24380,
      roundNumbers: [24380, 24400, 24500],
    });
    // 39 filler bars + explicit trigger: close 24397 > PDH+0.15·ATR(24395).
    // Tight upper wick (high=24399) keeps upperWick/range = 2/12 = 0.17 < 0.3.
    const filler = buildCandles(39, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(4).fill(160_000)],
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:39:00+05:30'),
      open: 24392, high: 24399, low: 24387, close: 24397, volume: 160_000,
    };
    const candles = [...filler, trigger];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    const meta = out!.metadata as { indicators: { agreement: number }; grade: string };
    expect(meta.indicators.agreement).toBeLessThanOrEqual(-2);
    expect(['B', 'C']).toContain(meta.grade);
  });

  // The MTF gate tests use REVERSAL-pattern fixtures (a pinbar wick into
  // PDH for SELL, a pinbar wick into PDL for BUY) — the same fixture
  // shape the existing pinbar-rejection test uses. We keep the gate
  // assertion narrow: gate-event presence + setup direction.
  const buyReversalFixture = (): { book: LevelBook; candles: CandleData[] } => {
    const book = baseLevelBook({ spot: 23965, pdl: 23950 });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 23960,
      high: 23975,
      low: 23942,    // wick INTO PDL from above
      close: 23972,  // body small + back above level
      volume: 130_000,
    };
    const earlier = buildCandles(24, {
      closes: Array(24).fill(23960),
      volumes: Array(24).fill(100_000),
    });
    return { book, candles: [...earlier, lastCandle] };
  };

  const sellReversalFixture = (): { book: LevelBook; candles: CandleData[] } => {
    const book = baseLevelBook({ spot: 24165 });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160,
      high: 24182,    // wick into PDH
      low: 24150,
      close: 24158,   // body small + back below level
      volume: 130_000,
    };
    const earlier = buildCandles(24, {
      closes: Array(24).fill(24160),
      volumes: Array(24).fill(100_000),
    });
    return { book, candles: [...earlier, lastCandle] };
  };

  // ---- MTF gate: bullish higher-TF allows BUY ----
  it('fires BUY setup when higher-TF trend is bullish (no conflict)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24050, ema21: 23980, bias: 'bullish' },
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
    const meta = out!.metadata as { higherTimeframeTrend: { bias: string } };
    expect(meta.higherTimeframeTrend.bias).toBe('bullish');
  });

  // ---- MTF gate: bearish higher-TF rejects BUY ----
  it('rejects BUY setup when higher-TF trend is bearish (mtf-conflict)', () => {
    const { book, candles } = buyReversalFixture();
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 23900, ema21: 24050, bias: 'bearish' },
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:mtf-conflict');
  });

  // ---- MTF gate: bullish higher-TF rejects SELL ----
  it('rejects SELL setup when higher-TF trend is bullish (mtf-conflict)', () => {
    const { book, candles } = sellReversalFixture();
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24180, ema21: 24100, bias: 'bullish' },
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:mtf-conflict');
  });

  // ---- MTF gate: neutral higher-TF allows setup ----
  it('fires BUY setup when higher-TF trend is neutral (gate skipped)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: { tf: '1h', ema9: 24000, ema21: 24000, bias: 'neutral' },
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
  });

  // ---- MTF gate: null higher-TF skips the gate ----
  it('fires BUY setup when higher-TF trend is null (no MTF data)', () => {
    const { book, candles } = buyReversalFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      higherTimeframeTrend: null,
    });
    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
    const meta = out!.metadata as { higherTimeframeTrend: unknown };
    expect(meta.higherTimeframeTrend).toBeNull();
  });

  // Breakout fixture: 24 filler bars + a last candle that closes strictly
  // above PDH+0.15·ATR (24195). Custom wick keeps upperWick/range under
  // BREAKOUT_WICK_MAX_RATIO 0.3. PDL/ORH/ORL/round-numbers are pushed out
  // of range so PDH is the only candidate — keeps the test laser-focused
  // on the regime branch.
  const breakoutFixture = (): { book: LevelBook; candles: CandleData[] } => {
    const book = baseLevelBook({
      spot: 24199, pdh: 24180,
      pdl: 22000, orh: null, orl: null, vwap: 22000,
      todayHigh: 24205, todayLow: 23900,
      roundNumbers: [],
    });
    const earlier = buildCandles(24, {
      closes: Array(24).fill(24100),
      volumes: Array(24).fill(100_000),
    });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24196, high: 24202, low: 24193, close: 24200, volume: 200_000,
    };
    return { book, candles: [...earlier, lastCandle] };
  };

  // ---- Regime gate: BREAKOUT + trending → grade upgraded ----
  it('upgrades BREAKOUT grade B→A when regime is trending', () => {
    const { book, candles } = breakoutFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      regime: 'trending',
    });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('BREAKOUT');
    expect(out!.metadata!.grade).toBe('A');
  });

  // ---- Regime gate: BREAKOUT + choppy → reject:regime-mismatch ----
  it('rejects BREAKOUT setup when regime is choppy', () => {
    const { book, candles } = breakoutFixture();
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      regime: 'choppy',
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:regime-mismatch');
  });

  // ---- Regime gate: REVERSAL + trending → reject:regime-mismatch ----
  it('rejects REVERSAL setup when regime is trending', () => {
    // Fixture isolates PDH as the only in-range level — pdl/orh/orl/round
    // pushed far away so the iteration only sees the pinbar rejection.
    const book = baseLevelBook({
      spot: 24165, pdh: 24180,
      pdl: 22000, orh: null, orl: null,
      vwap: 22000, todayHigh: 24182, todayLow: 23900,
      roundNumbers: [],
    });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160, high: 24182, low: 24150, close: 24158, volume: 130_000,
    };
    const earlier = buildCandles(24, { closes: Array(24).fill(24160), volumes: Array(24).fill(100_000) });
    const candles = [...earlier, lastCandle];
    const events: string[] = [];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      regime: 'trending',
      debug: (e) => events.push(e),
    });
    expect(out).toBeNull();
    expect(events).toContain('reject:regime-mismatch');
  });

  // ---- Regime gate: REVERSAL + choppy → grade upgraded ----
  it('upgrades REVERSAL grade B→A when regime is choppy', () => {
    const book = baseLevelBook({
      spot: 24165, pdh: 24180,
      pdl: 22000, orh: null, orl: null,
      vwap: 22000, todayHigh: 24182, todayLow: 23900,
      roundNumbers: [],
    });
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160, high: 24182, low: 24150, close: 24158, volume: 130_000,
    };
    const earlier = buildCandles(24, { closes: Array(24).fill(24160), volumes: Array(24).fill(100_000) });
    const candles = [...earlier, lastCandle];
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      regime: 'choppy',
    });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('REVERSAL');
    expect(out!.metadata!.grade).toBe('A');
  });

  // ---- Regime gate: BREAKOUT + normal → no change ----
  it('does not change grade when regime is normal (BREAKOUT)', () => {
    const { book, candles } = breakoutFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
      regime: 'normal',
    });
    expect(out).not.toBeNull();
    // Base grade is B (volume 2.0× passes but no confluence on PDH 24180).
    expect(out!.metadata!.grade).toBe('B');
  });

  // ---- Regime gate: undefined regime → no change (defensive) ----
  it('does not change grade when regime is undefined (defensive)', () => {
    const { book, candles } = breakoutFixture();
    const out = strategy.analyze({
      candles, levelBook: book, nowIst: '10:30',
    });
    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('B');
  });

  // ---- SetupContext.indicators populated ----
  it('populates SetupContext.indicators with non-null readings when history is sufficient', () => {
    const closes: number[] = [];
    let v = 24050;
    for (let i = 0; i < 39; i++) {
      v += i % 2 === 0 ? 4 : -1;
      closes.push(v);
    }
    // Trigger close 24197 > PDH+0.15·ATR(24195). Tight upper wick passes wick gate.
    const book = baseLevelBook({
      spot: 24197,
      pdh: 24180,
      roundNumbers: [24000, 24050, 24100],
    });
    const filler = buildCandles(39, {
      closes,
      volumes: [...Array(35).fill(100_000), ...Array(4).fill(160_000)],
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:39:00+05:30'),
      open: 24192, high: 24199, low: 24187, close: 24197, volume: 160_000,
    };
    const candles = [...filler, trigger];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    const ind = (out!.metadata as { indicators: Record<string, unknown> }).indicators;
    expect(ind.ema9).not.toBeNull();
    expect(ind.ema21).not.toBeNull();
    expect(ind.rsi14).not.toBeNull();
    expect(ind.macdHistogram).not.toBeNull();
    expect(ind.bollingerPosition).not.toBeNull();
    expect(ind.roc10).not.toBeNull();
    expect(typeof ind.agreement).toBe('number');
  });
});

describe('computeSlAndTarget — obstacle-aware TP1', () => {
  const baseLevelBook = {
    token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
    asOf: new Date(), pdh: 24100, pdl: 23900, prevClose: 24000,
    orh: null, orl: null, orLocked: false,
    prevOrh: null, prevOrl: null,
    spot: 24000, vwap: 0, todayHigh: 24000, todayLow: 24000,
    atr14: 100, lastTickAt: new Date(), roundNumbers: [],
  };
  const baseCandle = {
    timestamp: new Date(), open: 24000, high: 24010, low: 23990,
    close: 24000, volume: 1000,
  };

  function makeZone(overrides: Partial<StrongZone>): StrongZone {
    return {
      id: 'z1', token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
      type: 'support', upper: 23970, lower: 23930, isLine: false,
      strength: 60, classification: 'MEDIUM', touchCount: 5,
      lastTouchTimestamp: Date.now(),
      scoreBreakdown: { touchCount: 100, volumeScore: 0, wickDensity: 50,
        recencyScore: 80, reversalScore: 40, confluenceBonus: 30 },
      computedAt: Date.now(), expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  function computeSlAndTarget(args: {
    isLong: boolean; level: number; zones?: StrongZone[];
    setupType?: 'BREAKOUT' | 'REVERSAL';
  }) {
    const strategy = new LevelsContextStrategy();
    return (strategy as any).computeSlAndTarget({
      setupType: args.setupType ?? 'REVERSAL',
      isLong: args.isLong,
      level: args.level,
      atr: 100,
      levelBook: baseLevelBook,
      candidates: [],
      triggerCandle: { ...baseCandle, close: args.level },
      zones: args.zones ?? [],
    });
  }

  it('1. SELL with no zones falls back to fixed 1×R TP1', () => {
    // SELL REVERSAL: entry = triggerCandle.close = 24000;
    // stoploss = level + SL_BUFFER_ATR(0.25) * atr(100) = 24025;
    // slDist = 25; defaultTp1 = entry - slDist = 23975.
    const r = computeSlAndTarget({ isLong: false, level: 24000 });
    expect(r.partialTakeAt).toBeCloseTo(23975, 1);
    expect(r.tp1Source).toBe('fixed');
    expect(r.tp1Obstacle ?? null).toBeNull();
  });

  it('2. SELL with STRONG zone in path → TP1 at zone.upper + buffer', () => {
    const zone = makeZone({ classification: 'STRONG', strength: 75,
      touchCount: 5, type: 'support', upper: 23970, lower: 23930 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23980, 1);
    expect(r.tp1Source).toBe('obstacle');
    expect(r.tp1Obstacle).toEqual({
      classification: 'STRONG', touchCount: 5, nearEdge: 23970,
    });
  });

  it('3. SELL with MEDIUM zone touchCount=2 → ignored (touchCount filter)', () => {
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 2 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23975, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('4. SELL with WEAK zone in path → ignored (classification filter)', () => {
    const zone = makeZone({ classification: 'WEAK', touchCount: 5 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23975, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('5. SELL with MEDIUM zone too close (obstacleR < 0.4) → fallback to fixed', () => {
    // Zone upper=23990; nearEdge=23990; rawObstacleTp1 = 23990 + 0.1*100 = 24000 (= entry).
    // obstacleR = 0 / slDist(25) = 0 < MIN_TP1_R(0.4) → fallback to defaultTp1.
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 5,
      upper: 23990, lower: 23970 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23975, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('6. BUY with resistance zone in path → TP1 at zone.lower − buffer', () => {
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 4,
      type: 'resistance', upper: 24080, lower: 24050 });
    const r = computeSlAndTarget({ isLong: true, level: 24000, zones: [zone],
      setupType: 'BREAKOUT' });
    expect(r.partialTakeAt).toBeCloseTo(24040, 1);
    expect(r.tp1Source).toBe('obstacle');
    expect(r.tp1Obstacle?.nearEdge).toBeCloseTo(24050, 1);
  });

  it('7. BUY with two resistance zones → only the closest one used', () => {
    const closer = makeZone({ id: 'z-close', classification: 'MEDIUM',
      touchCount: 4, type: 'resistance', upper: 24080, lower: 24050 });
    const farther = makeZone({ id: 'z-far', classification: 'MEDIUM',
      touchCount: 4, type: 'resistance', upper: 24150, lower: 24120 });
    const r = computeSlAndTarget({ isLong: true, level: 24000,
      zones: [farther, closer], setupType: 'BREAKOUT' });
    expect(r.tp1Obstacle?.nearEdge).toBeCloseTo(24050, 1);
  });

  it('8. BUY with zone beyond target → ignored', () => {
    // BUY BREAKOUT: entry = level + BREAKOUT_BODY_ATR(0.15)*atr(100) = 24015;
    // stoploss = level - SL_BUFFER_ATR(0.25)*atr = 23975; slDist = 40;
    // target = entry + 2*slDist = 24095. Zone nearEdge(lower)=24220 > target → out.
    // defaultTp1 = entry + slDist = 24055.
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 4,
      type: 'resistance', upper: 24240, lower: 24220 });
    const r = computeSlAndTarget({ isLong: true, level: 24000, zones: [zone],
      setupType: 'BREAKOUT' });
    expect(r.partialTakeAt).toBeCloseTo(24055, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('9. SELL with valid obstacle clamps to NOT exceed target', () => {
    const zone = makeZone({ classification: 'STRONG', strength: 75,
      touchCount: 5, type: 'support', upper: 23805, lower: 23770 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeGreaterThan(r.target);
    expect(r.partialTakeAt).toBeLessThan(24000);
  });
});
