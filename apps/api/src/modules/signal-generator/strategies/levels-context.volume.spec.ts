// Tri-state volume — see docs/superpowers/specs/2026-08-07-trade-plan-design.md
// §1.3 / §3.4. `volumeRatio: null` means NO READING and must never behave
// like a real 0.
import { LevelsContextStrategy } from './levels-context.strategy';
import { LevelBook } from '../types/level-book.types';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';
import type { SetupContext } from '../types/setup-context.types';

describe('LevelsContextStrategy — tri-state volume', () => {
  let strategy: LevelsContextStrategy;
  beforeEach(() => {
    strategy = new LevelsContextStrategy();
    // Fixtures put the trigger candle at the END of the array.
    strategy.setParameters({ evaluateOnLastBar: true });
  });

  const buildCandles = (
    count: number,
    opts: { closes?: number[]; volumes?: number[] },
  ): CandleData[] => {
    const candles: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      const close = opts.closes?.[i] ?? 24100;
      candles.push({
        timestamp: new Date(`2026-04-27T10:${String(i).padStart(2, '0')}:00+05:30`),
        open: close - 5,
        high: close + 10,
        low: close - 10,
        close,
        volume: opts.volumes?.[i] ?? 0,
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
    spot: 24190,
    vwap: 24090,
    todayHigh: 24160,
    todayLow: 24050,
    atr14: 100,
    lastTickAt: new Date(),
    roundNumbers: [24000, 24050, 24100, 24150, 24200],
    ...overrides,
  });

  /**
   * The canonical PDH breakout fixture: close 24197 clears
   * PDH(24180) + 0.15·ATR(15), tight upper wick. Only the VOLUME varies
   * between the cases below.
   */
  const breakoutCandles = (fillerVolume: number, triggerVolume: number) => {
    const filler = buildCandles(24, {
      closes: Array(24).fill(24100),
      volumes: Array(24).fill(fillerVolume),
    });
    const trigger: CandleData = {
      timestamp: new Date('2026-04-27T10:24:00+05:30'),
      open: 24192, high: 24199, low: 24187, close: 24197, volume: triggerVolume,
    };
    return [...filler, trigger];
  };

  // ── Index: no candle volume, no proxy → null, gate falls through ──
  it('lets an index breakout through when there is NO volume reading at all', () => {
    // Angel reports volume:0 on every index bar → VMA20 is 0 → no reading.
    // Before the fix this produced volumeRatio 0, and no index could ever
    // produce a breakout setup.
    const out = strategy.analyze({
      candles: breakoutCandles(0, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
    });
    expect(out).not.toBeNull();
    const meta = out!.metadata as SetupContext;
    expect(meta.setupType).toBe('BREAKOUT');
    expect(meta.volumeRatio).toBeNull();
  });

  it('never prints a 0.00× volume claim when there is no reading', () => {
    const out = strategy.analyze({
      candles: breakoutCandles(0, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
    });
    expect(out!.reason).not.toContain('0.00×');
    expect(out!.reason).toContain('Volume not available');
  });

  // ── A REAL 0 is a measurement and still fails the gate ──
  it('still rejects a breakout on a REAL zero-volume reading', () => {
    // VMA20 > 0 (the instrument does report volume) but the trigger bar
    // traded nothing → ratio 0 → volume genuinely disconfirms.
    const out = strategy.analyze({
      candles: breakoutCandles(100_000, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
    });
    expect(out).toBeNull();
  });

  it('reports a real 0 as 0 and a missing reading as null in the gate trace', () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const debug = (event: string, detail?: Record<string, unknown>) => {
      if (event === 'in-window') seen.push(detail);
    };
    strategy.analyze({
      candles: breakoutCandles(100_000, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
      debug,
    });
    strategy.analyze({
      candles: breakoutCandles(0, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
      debug,
    });
    expect(seen[0]!.volumeRatio).toBe(0);
    expect(seen[0]!.volumeSource).toBe('candles');
    expect(seen[1]!.volumeRatio).toBeNull();
    expect(seen[1]!.volumeSource).toBe('none');
  });

  // ── Option-chain proxy ──
  it('uses the option-chain proxy for an index with no candle volume', () => {
    const out = strategy.analyze({
      candles: breakoutCandles(0, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
      proxyVolumeRatio: 2.4,
    });
    expect(out).not.toBeNull();
    const meta = out!.metadata as SetupContext;
    expect(meta.volumeRatio).toBe(2.4);
    expect(out!.reason).toContain('2.40×');
  });

  it('rejects the breakout when the proxy itself is below the volume floor', () => {
    // The proxy is a real measurement — it gates exactly like candle volume.
    const out = strategy.analyze({
      candles: breakoutCandles(0, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
      proxyVolumeRatio: 0.4,
    });
    expect(out).toBeNull();
  });

  it('leaves a real instrument on its own candle volume, ignoring any proxy', () => {
    const out = strategy.analyze({
      candles: breakoutCandles(100_000, 200_000),
      levelBook: baseLevelBook({ symbol: 'RELIANCE', token: '2885' }),
      nowIst: '10:00',
      proxyVolumeRatio: 9.9,
    });
    expect(out).not.toBeNull();
    const meta = out!.metadata as SetupContext;
    expect(meta.volumeRatio).toBeCloseTo(2, 6);
  });

  it('does not let a proxy rescue a real reading that failed the gate', () => {
    const out = strategy.analyze({
      candles: breakoutCandles(100_000, 0),
      levelBook: baseLevelBook(),
      nowIst: '10:00',
      proxyVolumeRatio: 5,
    });
    expect(out).toBeNull();
  });

  // ── Grade renormalisation ──
  describe('grade', () => {
    /**
     * Pinbar rejection at PDH — REVERSAL geometry ignores volume, so the
     * same setup fires for both a null reading and a real low one. Only
     * the GRADE differs, which is exactly what we want to observe.
     * ROUND 24182 sits within 0.1·ATR of PDH 24180 → confluence = 1, and
     * 10:00 IST is inside the prime morning window.
     */
    const reversalCandles = (fillerVolume: number, triggerVolume: number) => {
      const earlier = buildCandles(24, {
        closes: Array(24).fill(24160),
        volumes: Array(24).fill(fillerVolume),
      });
      const pinbar: CandleData = {
        timestamp: new Date('2026-04-27T10:24:00+05:30'),
        open: 24160, high: 24182, low: 24150, close: 24158, volume: triggerVolume,
      };
      return [...earlier, pinbar];
    };
    const reversalBook = () =>
      baseLevelBook({ spot: 24165, roundNumbers: [24182, 24000, 24100] });

    const gradeOf = (candles: CandleData[]): string | null => {
      const out = strategy.analyze({
        candles, levelBook: reversalBook(), nowIst: '10:00',
      });
      return out ? (out.metadata as SetupContext).grade : null;
    };

    it('skips the volume factor and renormalises over the rest when there is no reading', () => {
      // Confluence ✓ + prime window ✓, volume factor absent → renormalised
      // over the two factors that exist → base A. Scoring the missing
      // factor as 0 (the old behaviour) would have produced C.
      expect(gradeOf(reversalCandles(0, 0))).toBe('A');
    });

    it('scores a real sub-floor reading as the disconfirmation it is', () => {
      // Same setup, same confluence/prime window — but volume was actually
      // measured and came in below the floor → base C, not A.
      strategy.setParameters({ includeGradeC: true });
      expect(gradeOf(reversalCandles(100_000, 10_000))).toBe('C');
    });

    it('renormalises down too — no confluence and no prime window is still C', () => {
      // null must not mean "free upgrade": with neither remaining factor
      // present the renormalised score is 0 → C.
      strategy.setParameters({ includeGradeC: true });
      const out = strategy.analyze({
        candles: reversalCandles(0, 0),
        levelBook: baseLevelBook({ spot: 24165, roundNumbers: [24000, 24100] }),
        nowIst: '11:30', // outside both prime windows
      });
      expect(out).not.toBeNull();
      expect((out!.metadata as SetupContext).grade).toBe('C');
    });
  });
});
