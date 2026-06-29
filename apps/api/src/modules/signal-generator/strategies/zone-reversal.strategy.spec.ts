// zone-reversal.strategy.spec.ts
import { ZoneReversalStrategy } from './zone-reversal.strategy';
import { StrongZone } from '../types/zone.types';
import { LevelBook } from '../types/level-book.types';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';

describe('ZoneReversalStrategy.analyze', () => {
  let strategy: ZoneReversalStrategy;

  beforeEach(() => {
    strategy = new ZoneReversalStrategy();
  });

  // -----------------------------------------------------------------------
  // Fixtures
  // -----------------------------------------------------------------------

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

  // Build N base candles ending at a fixed close. Used to flesh out the
  // candle array so the strategy has prior context. The last candle is
  // overwritten by the trigger fixture.
  const buildBaseCandles = (count: number, baseClose: number): CandleData[] => {
    const out: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      out.push({
        timestamp: new Date(`2026-04-27T10:${String(i).padStart(2, '0')}:00+05:30`),
        open: baseClose - 5,
        high: baseClose + 5,
        low: baseClose - 5,
        close: baseClose,
        volume: 100_000,
      });
    }
    return out;
  };

  const makeStrongZone = (overrides?: Partial<StrongZone>): StrongZone => ({
    id: 'zone-pdh-1',
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    type: 'resistance',
    upper: 24200,
    lower: 24180,
    isLine: false,
    strength: 75,
    classification: 'STRONG',
    touchCount: 3,
    lastTouchTimestamp: Date.now(),
    scoreBreakdown: {
      touchCount: 75,
      reversalScore: 80,
      volumeScore: 70,
      recencyScore: 90,
      confluenceBonus: 60,
      wickDensity: 70,
    },
    computedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    ...overrides,
  });

  // Pin-bar trigger candle into a resistance zone (24180-24200): wick UP
  // into the zone, body BEAR, close back below the zone center.
  const pinBarResistanceTrigger = (): CandleData => ({
    timestamp: new Date('2026-04-27T11:00:00+05:30'),
    open: 24170,
    high: 24195, // wick into zone
    low: 24160,
    close: 24165, // close BELOW zone center (24190)
    volume: 130_000,
  });

  // Pin-bar trigger into a support zone: wick DOWN into the zone, body
  // BULL, close back above the zone center.
  const pinBarSupportTrigger = (): CandleData => ({
    timestamp: new Date('2026-04-27T11:00:00+05:30'),
    open: 23970,
    high: 23985,
    low: 23945, // wick into support 23940-23960
    close: 23980, // close above zone center (23950)
    volume: 130_000,
  });

  // Bearish engulfing trigger into a resistance zone. Prev bar bullish,
  // current bar fully engulfs prev body and closes below zone center.
  const engulfingResistanceCandles = (): CandleData[] => {
    const earlier = buildBaseCandles(8, 24160);
    const prev: CandleData = {
      timestamp: new Date('2026-04-27T10:55:00+05:30'),
      open: 24160,
      high: 24180,
      low: 24158,
      close: 24178, // bullish
      volume: 110_000,
    };
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T11:00:00+05:30'),
      // engulfs prev body (24160-24178) — open above, close below
      open: 24185,
      high: 24195, // touches zone (lower=24180)
      low: 24150,
      close: 24155, // bearish close, well below zone center
      volume: 160_000,
    };
    return [...earlier, prev, trigger];
  };

  // -----------------------------------------------------------------------
  // 1. Pin bar reversal at STRONG resistance fires SELL signal
  // -----------------------------------------------------------------------
  it('fires SELL on STRONG resistance touch + pin bar reversal', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];
    const zone = makeStrongZone(); // strength 75 → grade B

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).not.toBeNull();
    expect(out!.side).toBe('SELL');
    expect(out!.metadata!.setupType).toBe('REVERSAL');
    expect(out!.metadata!.levelType).toBe('STRONG_ZONE');
    expect(out!.metadata!.candlePattern).toBe('pin-bar');
    expect(out!.metadata!.grade).toBe('B');
  });

  // -----------------------------------------------------------------------
  // 2. Engulfing reversal at STRONG resistance fires SELL signal
  // -----------------------------------------------------------------------
  it('fires SELL on STRONG resistance touch + bearish engulfing', () => {
    const book = baseLevelBook({ spot: 24190 });
    const candles = engulfingResistanceCandles();
    const zone = makeStrongZone({ strength: 85 }); // grade A

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).not.toBeNull();
    expect(out!.metadata!.candlePattern).toBe('engulfing');
    expect(out!.metadata!.grade).toBe('A');
  });

  // -----------------------------------------------------------------------
  // 3. MEDIUM zone does NOT fire (only STRONG triggers)
  // -----------------------------------------------------------------------
  it('does NOT fire on MEDIUM zone — STRONG-only gate', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];
    const zone = makeStrongZone({
      classification: 'MEDIUM',
      strength: 55,
    });

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 4. Touch but no reversal pattern → no fire
  // -----------------------------------------------------------------------
  it('does NOT fire when no reversal candle pattern is present', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    // Boring marubozu candle that pierces zone but lacks pin/engulf/rejection.
    // Closes BELOW zone center but body has tiny upper wick — not pin (wick<2*body),
    // not strong-rejection (no upper wick to speak of into the zone).
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T11:00:00+05:30'),
      open: 24178,
      high: 24181, // barely tags zone lower (24180)
      low: 24170,
      close: 24172,
      volume: 110_000,
    };
    const candles = [...earlier, trigger];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [makeStrongZone()],
    });

    // Body 6, range 11, body/range ≈ 0.55 < 0.6 → no strong-rejection.
    // Upper wick 3, body 6 — wick < 2*body → no pin. → null.
    expect(out).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. Anti-rule: touchCount > 6 → no fire
  // -----------------------------------------------------------------------
  it('does NOT fire when zone has been touched > 6 times', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];
    const zone = makeStrongZone({ touchCount: 7 });

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 6. Anti-rule: chasing (LTP > 0.5*ATR from zone) → no fire
  // -----------------------------------------------------------------------
  it('does NOT fire when LTP is > 0.5×ATR from zone (chasing)', () => {
    // ATR=100, zone center=24190, threshold=50. Spot 60 away → reject.
    const book = baseLevelBook({ spot: 24130 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [makeStrongZone()],
    });

    expect(out).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 7. SL placement: 0.3 * ATR beyond zone edge
  // -----------------------------------------------------------------------
  it('places SL at 0.3 × ATR beyond zone edge', () => {
    const book = baseLevelBook({ spot: 24190, atr14: 100 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];
    const zone = makeStrongZone(); // upper=24200, lower=24180

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).not.toBeNull();
    // SELL setup → SL = zone.upper + 0.3 * ATR = 24200 + 30 = 24230
    expect(out!.stoplossPrice).toBeCloseTo(24230, 4);
  });

  // -----------------------------------------------------------------------
  // 8. Target: nearest opposite STRONG zone OR 2R, whichever first
  // -----------------------------------------------------------------------
  it('uses nearest opposite STRONG zone for target when closer than 2R', () => {
    // SELL setup (resistance at 24180-24200). Entry ≈ 24165.
    // SL ~24230 → SL distance ~65 → 2R fallback target ≈ 24035.
    // Place opposite STRONG support at 24100 — closer than 24035.
    const book = baseLevelBook({ spot: 24190, atr14: 100 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];
    const resistanceZone = makeStrongZone();
    const supportZone = makeStrongZone({
      id: 'zone-support-1',
      type: 'support',
      upper: 24105,
      lower: 24095,
      strength: 80,
    });

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [resistanceZone, supportZone],
    });

    expect(out).not.toBeNull();
    // For SELL, facing edge of support zone is upper (hit first as price falls) = 24105.
    // 2R target = entry - 2*slDist. Entry 24165, SL 24230 → slDist 65 → 2R = 24035.
    // First-hit (max) of (24105, 24035) = 24105 → use the zone.
    expect(out!.targetPrice).toBeCloseTo(24105, 4);
  });

  it('falls back to 2R target when no opposite STRONG zone is in range', () => {
    const book = baseLevelBook({ spot: 24190, atr14: 100 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [makeStrongZone()],
    });

    expect(out).not.toBeNull();
    const entry = out!.entryPrice;
    const slDist = Math.abs(out!.stoplossPrice - entry);
    // Fallback target = entry - 2*slDist for a SELL.
    expect(out!.targetPrice).toBeCloseTo(entry - 2 * slDist, 4);
  });

  // -----------------------------------------------------------------------
  // 9. Grade A if strength >= 80, else B
  // -----------------------------------------------------------------------
  it('grades A when zone strength >= 80', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [makeStrongZone({ strength: 80 })],
    });

    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('A');
  });

  it('grades B when zone strength is 70-79', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [makeStrongZone({ strength: 75 })],
    });

    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('B');
  });

  // -----------------------------------------------------------------------
  // Bonus: support-side BUY signal mirrors the resistance-side SELL.
  // -----------------------------------------------------------------------
  it('fires BUY on STRONG support touch + pin bar reversal', () => {
    const book = baseLevelBook({ spot: 23960, atr14: 100 });
    const earlier = buildBaseCandles(10, 23980);
    const candles = [...earlier, pinBarSupportTrigger()];
    const zone = makeStrongZone({
      id: 'zone-support-1',
      type: 'support',
      upper: 23960,
      lower: 23940,
    });

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '11:00',
      zones: [zone],
    });

    expect(out).not.toBeNull();
    expect(out!.side).toBe('BUY');
    // SL = zone.lower - 0.3*ATR = 23940 - 30 = 23910
    expect(out!.stoplossPrice).toBeCloseTo(23910, 4);
  });

  // -----------------------------------------------------------------------
  // Session-edge anti-rule
  // -----------------------------------------------------------------------
  it('does NOT fire in the first 5 minutes of the session', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '09:18',
      zones: [makeStrongZone()],
    });

    expect(out).toBeNull();
  });

  it('does NOT fire in the last 5 minutes of the session', () => {
    const book = baseLevelBook({ spot: 24190 });
    const earlier = buildBaseCandles(10, 24160);
    const candles = [...earlier, pinBarResistanceTrigger()];

    const out = strategy.analyze({
      candles,
      levelBook: book,
      nowIst: '15:28',
      zones: [makeStrongZone()],
    });

    expect(out).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Strategy must NEVER throw
  // -----------------------------------------------------------------------
  it('returns null on malformed input rather than throwing', () => {
    expect(() =>
      strategy.analyze({} as unknown as Parameters<ZoneReversalStrategy['analyze']>[0]),
    ).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // getParameters / setParameters
  // -----------------------------------------------------------------------
  it('exposes tunable parameters via getParameters / setParameters', () => {
    const initial = strategy.getParameters();
    expect(initial.minStrengthForFire).toBe(70);
    expect(initial.maxTouchCount).toBe(6);
    expect(initial.chasingThresholdAtr).toBe(0.5);

    strategy.setParameters({ minStrengthForFire: 85 });
    expect(strategy.getParameters().minStrengthForFire).toBe(85);
  });
});
