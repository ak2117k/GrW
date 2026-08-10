import { backtestSrLevels, type BacktestCandle } from './sr-backtest';

/**
 * The harness that answers "how accurate is our S/R, actually".
 *
 * The properties worth pinning are the ones that decide whether the resulting
 * number can be trusted: an empty sample reports null rather than 0%, one
 * interaction is counted once rather than once per bar, and hold rate and
 * follow-through rate stay separate — a level can be a good fade and a bad
 * breakout, and averaging them hides exactly that.
 */

const OPTS = { timeframe: '15m', barsPerSession: 25 };

function bar(i: number, close: number, spread = 2, volume = 1000): BacktestCandle {
  return {
    time: 1_700_000_000 + i * 900,
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume,
  };
}

/** Flat, quiet series — nothing ever reaches a level decisively. */
function flat(n: number, price = 100): BacktestCandle[] {
  return Array.from({ length: n }, (_, i) => bar(i, price));
}

describe('backtestSrLevels — trustworthiness of the number', () => {
  it('reports null, never 0%, when nothing was ever tested', () => {
    const report = backtestSrLevels(flat(60), OPTS);
    for (const k of ['PDH', 'PDL', 'ROUND', 'VWAP'] as const) {
      // A rate of 0 would read as "these levels never hold", which is a
      // measurement. No sample is not a measurement.
      if (report.byKind[k].tested === 0) expect(report.byKind[k].holdRate).toBeNull();
      if (report.followThrough[k].breaks === 0) expect(report.followThrough[k].rate).toBeNull();
    }
  });

  it('refuses to score a series too short to mean anything', () => {
    const report = backtestSrLevels(flat(10), OPTS);
    expect(report.candles).toBe(10);
    expect(report.overall.rate).toBeNull();
    expect(report.overall.breaks).toBe(0);
  });

  it('keeps hold rate and follow-through rate separate', () => {
    // A level can be excellent to fade and terrible to break. One blended
    // "accuracy" figure would hide that, so the report must never expose one.
    const report = backtestSrLevels(flat(60), OPTS);
    expect(report).toHaveProperty('byKind');
    expect(report).toHaveProperty('followThrough');
    expect(report).not.toHaveProperty('accuracy');
  });

  it('counts one interaction once, not once per bar it lingers', () => {
    // Price parks against the same round level for many consecutive bars.
    const parked = Array.from({ length: 80 }, (_, i) => bar(i, 100.2));
    const report = backtestSrLevels(parked, OPTS);
    // Without de-duplication this would be dozens of "tests" of one level.
    expect(report.byKind.ROUND.tested).toBeLessThan(30);
  });

  it('records a decisive break as a break, not a hold', () => {
    // Quiet, then a large-bodied bar straight through the round number.
    const candles: BacktestCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(bar(i, 99.5, 0.4));
    for (let i = 40; i < 60; i++) {
      const close = 100 + (i - 39) * 1.5;
      candles.push({
        time: 1_700_000_000 + i * 900,
        open: close - 1.4,
        high: close + 0.3,
        low: close - 1.6,
        close,
        volume: 2000,
      });
    }
    const report = backtestSrLevels(candles, OPTS);
    const round = report.byKind.ROUND;
    expect(round.tested).toBeGreaterThan(0);
    expect(round.broke).toBeGreaterThan(0);
  });

  it('every reported rate has its sample size beside it', () => {
    const report = backtestSrLevels(flat(60), OPTS);
    for (const k of ['PDH', 'PDL', 'ROUND', 'VWAP'] as const) {
      const f = report.followThrough[k];
      // A percentage without an n is not reportable — the same rule the live
      // hit-rate follows.
      if (f.rate !== null) expect(f.breaks).toBeGreaterThan(0);
    }
    if (report.overall.rate !== null) expect(report.overall.breaks).toBeGreaterThan(0);
  });

  it('never throws on malformed input', () => {
    expect(() => backtestSrLevels([] as never, OPTS)).not.toThrow();
    expect(() => backtestSrLevels(null as never, OPTS)).not.toThrow();
  });
});
