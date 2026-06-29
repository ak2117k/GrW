/**
 * Tests for ChartinkGatedStrategy.
 *
 * The strategy replays the live Chartink-gated entry logic + watch-monitor
 * exits over historical candles. We mock ChartinkScoringService entirely so
 * NO real broker calls are made — the fake score() is fully controlled per
 * test.
 */

import { ChartinkGatedStrategy } from './chartink-gated.strategy';
import {
  ChartinkScoringService,
  ScoringResult,
} from '../../chartink/services/chartink-scoring.service';
import { BacktestInput, CandleData } from '../../../common/interfaces/trading-strategy.interface';

/** Build a candle at a given index/timestamp. */
function candle(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  baseTime = Date.UTC(2026, 0, 1, 9, 15),
  stepMs = 24 * 60 * 60 * 1000,
): CandleData {
  return {
    timestamp: new Date(baseTime + i * stepMs),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1000,
  };
}

/** A passing scoring result: score high, both gate checks passed. */
function passingScore(score = 75): ScoringResult {
  return {
    score,
    lotCount: 2,
    dataStarved: false,
    checks: [
      { name: 'MACD on 5m', points: 8, pointsPossible: 8, passed: true },
      { name: 'SuperTrend match', points: 10, pointsPossible: 10, passed: true },
    ],
  };
}

/** A failing scoring result with a custom mutation applied. */
function makeScore(overrides: Partial<ScoringResult>, checkOverrides: Record<string, boolean> = {}): ScoringResult {
  const base = passingScore();
  const checks = base.checks.map((c) =>
    checkOverrides[c.name] !== undefined ? { ...c, passed: checkOverrides[c.name] } : c,
  );
  return { ...base, ...overrides, checks };
}

/**
 * A mock ChartinkScoringService whose score() returns a queue of results and
 * whose prefetch() returns a stub ScoringCandleSource. The same stub object is
 * returned on every prefetch() call so tests can assert it is threaded into
 * every score() call.
 */
function mockScoring(
  resolver: (input: { asOf?: Date }) => ScoringResult,
): ChartinkScoringService {
  // Stub in-memory candle source — identity is what matters for the wiring
  // assertions; getCandles() is never exercised by the mocked score().
  const candleSource = { getCandles: jest.fn(() => []) };
  return {
    score: jest.fn(async (input: { asOf?: Date }) => resolver(input)),
    prefetch: jest.fn(async () => candleSource),
  } as unknown as ChartinkScoringService;
}

const CONTEXT = { symbol: 'TCS', token: '11536', exchange: 'NSE' };

describe('ChartinkGatedStrategy', () => {
  describe('metadata', () => {
    it('exposes name, segments and timeframes', () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore()));
      expect(strat.name).toBe('chartink-gated');
      expect(strat.supportedSegments).toContain('EQUITY');
      expect(strat.preferredTimeframes).toEqual(['1d', '1h']);
    });

    it('analyze() is intentionally inert and returns null', () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore()));
      expect(
        strat.analyze({ symbol: 'TCS', exchange: 'NSE', ltp: 100, candles: [], volume: 0 }),
      ).toBeNull();
    });

    it('getParameters exposes the live-strategy defaults', () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore()));
      expect(strat.getParameters()).toEqual({
        scoreThreshold: 60,
        targetPct: 2,
        stopPct: 1,
        graceMinutes: 10,
        scoreDecaySL: 50,
        maxHoldBars: 20,
      });
    });

    it('setParameters merges provided params', () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore()));
      strat.setParameters({ scoreThreshold: 70, targetPct: 5 });
      expect(strat.getParameters().scoreThreshold).toBe(70);
      expect(strat.getParameters().targetPct).toBe(5);
      expect(strat.getParameters().stopPct).toBe(1);
    });
  });

  describe('backtest — missing context', () => {
    it('returns an empty result when token/symbol/exchange are missing', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore()));
      const input: BacktestInput = {
        candles: [candle(0, 100, 101, 99, 100), candle(1, 100, 101, 99, 100)],
        initialCapital: 100000,
        positionSize: 10,
        // no symbol/token/exchange
      };
      const result = await strat.backtest(input);
      expect(result.totalTrades).toBe(0);
      expect(result.trades).toEqual([]);
    });
  });

  describe('backtest — entry gating', () => {
    it('opens a trade when score >= threshold and both gate checks pass', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      // entry at bar 0 (close 100), target 2% = 102 hit on bar 1's high.
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      expect(result.trades[0].side).toBe('BUY');
      expect(result.trades[0].entryPrice).toBe(100);
    });

    it('does NOT open a trade when score is below threshold', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => makeScore({ score: 40 })));
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
    });

    it('does NOT open a trade when the MACD on 5m check fails', async () => {
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => makeScore({ score: 80 }, { 'MACD on 5m': false })),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
    });

    it('does NOT open a trade when the SuperTrend match check fails', async () => {
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => makeScore({ score: 80 }, { 'SuperTrend match': false })),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
    });

    it('skips a data-starved bar entirely', async () => {
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => makeScore({ score: 90, dataStarved: true })),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
    });
  });

  describe('backtest — exits', () => {
    it('exits on target', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      // entry close 100 → target 102. Bar 1 high 103 hits target.
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.8, 102.5),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      expect(result.trades[0].reason).toBe('target');
      expect(result.trades[0].exitPrice).toBe(102); // 100 * 1.02
      expect(result.trades[0].pnl).toBe(20); // (102-100)*10
    });

    it('exits on stoploss', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      // entry close 100 → stop 99. Bar 1 low 98 hits stop.
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 100.2, 98, 98.5),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      expect(result.trades[0].reason).toBe('stoploss');
      expect(result.trades[0].exitPrice).toBe(99); // 100 * 0.99
      expect(result.trades[0].pnl).toBe(-10);
    });

    it('checks stop before target within the same bar (conservative)', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      // Bar 1 hits BOTH stop (low 98) and target (high 103) — stop must win.
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 98, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.trades[0].reason).toBe('stoploss');
    });

    it('exits on score-decay after the grace period', async () => {
      // First score() call (entry) is passing & high. Subsequent calls (re-score
      // during the hold) return a low score → triggers score-decay exit.
      let calls = 0;
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => {
          calls += 1;
          return calls === 1 ? passingScore(75) : makeScore({ score: 30 });
        }),
      );
      // 15m bars so grace (10 min) is crossed by bar 1. No target/stop hit.
      const baseTime = Date.UTC(2026, 0, 1, 9, 15);
      const step = 15 * 60 * 1000;
      const candles = [
        candle(0, 100, 100.5, 99.8, 100, baseTime, step),
        candle(1, 100, 100.4, 99.6, 100.1, baseTime, step),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      expect(result.trades[0].reason).toBe('score-decay');
      expect(result.trades[0].exitPrice).toBe(100.1); // bar 1 close
    });

    it('exits on timeout when no other exit fires within maxHoldBars', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      strat.setParameters({ maxHoldBars: 2, graceMinutes: 100000 }); // disable score-decay
      // Flat candles, never hit target/stop.
      const candles = [
        candle(0, 100, 100.3, 99.7, 100),
        candle(1, 100, 100.3, 99.7, 100),
        candle(2, 100, 100.3, 99.7, 100.2),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      expect(result.trades[0].reason).toBe('timeout');
    });
  });

  describe('backtest — metrics', () => {
    it('computes winRate, totalReturn, maxDrawdown and sharpeRatio', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      strat.setParameters({ graceMinutes: 100000 }); // no score-decay noise
      // bar0 entry → bar1 target hit (+20). bar2 entry → bar3 stop hit (-10).
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.8, 102.5), // target hit
        candle(2, 100, 100.5, 99.5, 100),
        candle(3, 100, 100.2, 98, 98.5), // stop hit
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(2);
      expect(result.winRate).toBe(50);
      expect(result.totalReturn).toBe(10); // +20 - 10
      expect(result.totalReturnPercent).toBeCloseTo(0.01, 4);
      expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(typeof result.sharpeRatio).toBe('number');
    });
  });

  describe('backtest — barLog diagnostics', () => {
    it('logs a data-starved entry-scan bar as skipped/data-starved', async () => {
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => makeScore({ score: 90, dataStarved: true })),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      // No trades, every bar is entry-scanned and skipped.
      expect(result.totalTrades).toBe(0);
      expect(result.barLog).toBeDefined();
      expect(result.barLog).toHaveLength(2);
      const first = result.barLog![0];
      expect(first.time).toBe(candles[0].timestamp.toISOString());
      expect(first.score).toBe(90);
      expect(first.dataStarved).toBe(true);
      expect(first.decision).toBe('skipped');
      expect(first.reason).toBe('data-starved');
    });

    it('logs a sub-threshold-score entry-scan bar as skipped with the score reason', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => makeScore({ score: 52 })));
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
      expect(result.barLog).toHaveLength(2);
      const first = result.barLog![0];
      expect(first.score).toBe(52);
      expect(first.dataStarved).toBe(false);
      expect(first.decision).toBe('skipped');
      expect(first.reason).toBe('score 52 below threshold 60');
    });

    it('logs a gate-failed entry-scan bar as skipped with the gate reason', async () => {
      const strat = new ChartinkGatedStrategy(
        mockScoring(() => makeScore({ score: 80 }, { 'MACD on 5m': false })),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(0);
      expect(result.barLog).toHaveLength(2);
      const first = result.barLog![0];
      expect(first.score).toBe(80);
      expect(first.macd5m).toBe(false);
      expect(first.supertrend).toBe(true);
      expect(first.decision).toBe('skipped');
      expect(first.reason).toBe('MACD-5m / SuperTrend gate failed');
    });

    it('logs an entered entry-scan bar as entered with an empty reason', async () => {
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      // entry at bar 0 (close 100), target 2% = 102 hit on bar 1's high.
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.5, 101),
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      // Only bar 0 is entry-scanned; bar 1 is consumed as the exit bar.
      expect(result.barLog).toHaveLength(1);
      const entered = result.barLog![0];
      expect(entered.time).toBe(candles[0].timestamp.toISOString());
      expect(entered.score).toBe(75);
      expect(entered.dataStarved).toBe(false);
      expect(entered.macd5m).toBe(true);
      expect(entered.supertrend).toBe(true);
      expect(entered.decision).toBe('entered');
      expect(entered.reason).toBe('');
    });

    it('logs exactly one entry per entry-scanned bar across a mixed run', async () => {
      // bar0: low score → skipped. bar1: passing → entered, bar2 is exit bar.
      const strat = new ChartinkGatedStrategy(
        mockScoring(({ asOf }) => {
          const t0 = Date.UTC(2026, 0, 1, 9, 15);
          // bar 0 timestamp → low score; everything else → passing.
          return asOf && asOf.getTime() === t0 ? makeScore({ score: 40 }) : passingScore(75);
        }),
      );
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 100.5, 99.5, 100),
        candle(2, 100, 103, 99.5, 102.5), // target hit for the bar-1 trade
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(result.totalTrades).toBe(1);
      // bar0 entry-scanned (skipped), bar1 entry-scanned (entered),
      // bar2 is the exit bar — NOT entry-scanned.
      expect(result.barLog).toHaveLength(2);
      expect(result.barLog![0].decision).toBe('skipped');
      expect(result.barLog![0].reason).toBe('score 40 below threshold 60');
      expect(result.barLog![1].decision).toBe('entered');
      expect(result.barLog![1].reason).toBe('');
    });

    it('does NOT change trading behavior — trades/metrics identical with barLog present', async () => {
      // Same scenario as the metrics test: behavior-unchanged guard.
      const strat = new ChartinkGatedStrategy(mockScoring(() => passingScore(75)));
      strat.setParameters({ graceMinutes: 100000 });
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 103, 99.8, 102.5), // target hit
        candle(2, 100, 100.5, 99.5, 100),
        candle(3, 100, 100.2, 98, 98.5), // stop hit
      ];
      const result = await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      // Trades array must be byte-identical to the pre-change expectation.
      expect(result.trades).toEqual([
        {
          entryTime: candles[0].timestamp,
          exitTime: candles[1].timestamp,
          side: 'BUY',
          entryPrice: 100,
          exitPrice: 102,
          pnl: 20,
          reason: 'target',
        },
        {
          entryTime: candles[2].timestamp,
          exitTime: candles[3].timestamp,
          side: 'BUY',
          entryPrice: 100,
          exitPrice: 99,
          pnl: -10,
          reason: 'stoploss',
        },
      ]);
      expect(result.totalTrades).toBe(2);
      expect(result.winRate).toBe(50);
      expect(result.totalReturn).toBe(10);
      // barLog records only entry-scanned bars: bar0 (entered) and bar2 (entered).
      expect(result.barLog).toHaveLength(2);
      expect(result.barLog!.map((b) => b.decision)).toEqual(['entered', 'entered']);
    });
  });

  describe('backtest — candle prefetch wiring', () => {
    it('calls scoring.prefetch exactly once before the bar-walk', async () => {
      const scoring = mockScoring(() => passingScore(75));
      const strat = new ChartinkGatedStrategy(scoring);
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 100.5, 99.5, 100),
        candle(2, 100, 100.5, 99.5, 100),
      ];
      await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(scoring.prefetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT call scoring.prefetch when instrument context is missing', async () => {
      const scoring = mockScoring(() => passingScore(75));
      const strat = new ChartinkGatedStrategy(scoring);
      await strat.backtest({
        candles: [candle(0, 100, 101, 99, 100), candle(1, 100, 101, 99, 100)],
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(scoring.prefetch).not.toHaveBeenCalled();
    });

    it('passes token/symbol/exchange and the candle range to prefetch', async () => {
      const scoring = mockScoring(() => makeScore({ score: 40 })); // never enter
      const strat = new ChartinkGatedStrategy(scoring);
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 100.5, 99.5, 100),
      ];
      await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });
      expect(scoring.prefetch).toHaveBeenCalledWith(
        '11536',
        'TCS',
        'NSE',
        candles[0].timestamp,
        candles[candles.length - 1].timestamp,
      );
    });

    it('prefers explicit startDate/endDate over the candle range', async () => {
      const scoring = mockScoring(() => makeScore({ score: 40 })); // never enter
      const strat = new ChartinkGatedStrategy(scoring);
      const candles = [
        candle(0, 100, 100.5, 99.5, 100),
        candle(1, 100, 100.5, 99.5, 100),
      ];
      const startDate = new Date(Date.UTC(2025, 11, 1));
      const endDate = new Date(Date.UTC(2026, 1, 1));
      await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
        startDate,
        endDate,
      });
      expect(scoring.prefetch).toHaveBeenCalledWith(
        '11536',
        'TCS',
        'NSE',
        startDate,
        endDate,
      );
    });

    it('threads the prefetched candleSource into every score() call', async () => {
      // Entry score passing, then a low re-score forces a score-decay exit so
      // BOTH the entry-score and the re-score code paths run.
      let calls = 0;
      const scoring = mockScoring(() => {
        calls += 1;
        return calls === 1 ? passingScore(75) : makeScore({ score: 30 });
      });
      const strat = new ChartinkGatedStrategy(scoring);
      const baseTime = Date.UTC(2026, 0, 1, 9, 15);
      const step = 15 * 60 * 1000; // 15m bars → grace crossed by bar 1
      const candles = [
        candle(0, 100, 100.5, 99.8, 100, baseTime, step),
        candle(1, 100, 100.4, 99.6, 100.1, baseTime, step),
      ];
      await strat.backtest({
        ...CONTEXT,
        candles,
        initialCapital: 100000,
        positionSize: 10,
      });

      // The exact stub object prefetch() resolved to.
      const candleSource = await (scoring.prefetch as jest.Mock).mock.results[0]
        .value;
      const scoreMock = scoring.score as jest.Mock;
      expect(scoreMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [scoreInput] of scoreMock.mock.calls) {
        expect(scoreInput.candleSource).toBe(candleSource);
      }
    });
  });
});
