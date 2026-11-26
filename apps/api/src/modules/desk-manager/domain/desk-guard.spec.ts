import { evaluateGuard } from './desk-guard';
import type { DayPnlPath } from './desk.types';

const cfg = { drawdownRupees: 5000, dayLossRupees: 8000, lossStreak: 3 };
const now = new Date('2026-11-26T06:00:00Z');
const none = { until: null, scope: null };
const path = (p: Partial<DayPnlPath>): DayPnlPath => ({ realised: 0, open: 0, total: 0, peak: 0, drawdownFromPeak: 0, lossStreak: 0, closed: [], ...p });

describe('evaluateGuard', () => {
  it('blocks at drawdown 5000', () => {
    const g = evaluateGuard(path({ peak: 6000, total: 1000, realised: 1000, drawdownFromPeak: 5000 }), cfg, none, null, now);
    expect(g.blocked).toBe(true);
    expect(g.reasons).toEqual(['drawdown ₹5000 ≥ ₹5000']);
  });

  it('does not block just under the drawdown', () => {
    expect(evaluateGuard(path({ peak: 6000, total: 1001, drawdownFromPeak: 4999 }), cfg, none, null, now).blocked).toBe(false);
  });

  it('blocks at day loss 8000', () => {
    const g = evaluateGuard(path({ realised: -6000, open: -2000, total: -8000, peak: 0, drawdownFromPeak: 8000 }), { ...cfg, drawdownRupees: 100000 }, none, null, now);
    expect(g.blocked).toBe(true);
    expect(g.reasons).toEqual(['day loss ₹8000 ≥ ₹8000']);
  });

  it('blocks after 3 losers', () => {
    const g = evaluateGuard(path({ lossStreak: 3, total: -900, drawdownFromPeak: 900 }), cfg, none, null, now);
    expect(g.blocked).toBe(true);
    expect(g.reasons).toEqual(['3 losers in a row ≥ 3']);
  });

  it('allows at 2 losers', () => {
    const g = evaluateGuard(path({ lossStreak: 2, total: -600, drawdownFromPeak: 600 }), cfg, none, null, now);
    expect(g).toMatchObject({ blocked: false, reasons: [], pausedUntil: null, pauseScope: null });
  });

  it('pause all blocks, pause NIFTY blocks only NIFTY', () => {
    const until = new Date(now.getTime() + 30 * 60_000);
    const all = evaluateGuard(path({}), cfg, { until, scope: 'all' }, 'BANKNIFTY', now);
    expect(all.blocked).toBe(true);
    expect(all.reasons[0]).toContain('paused (all) until');
    expect(all).toMatchObject({ pausedUntil: until, pauseScope: 'all' });
    expect(evaluateGuard(path({}), cfg, { until, scope: 'all' }, null, now).blocked).toBe(true);
    expect(evaluateGuard(path({}), cfg, { until, scope: 'NIFTY' }, 'nifty', now).blocked).toBe(true);
    const other = evaluateGuard(path({}), cfg, { until, scope: 'NIFTY' }, 'BANKNIFTY', now);
    expect(other.blocked).toBe(false);
    expect(other).toMatchObject({ pausedUntil: until, pauseScope: 'NIFTY' });
  });

  it('expired pause does not block', () => {
    const g = evaluateGuard(path({}), cfg, { until: new Date(now.getTime() - 1), scope: 'all' }, null, now);
    expect(g).toMatchObject({ blocked: false, pausedUntil: null, pauseScope: null });
  });

  it('every rule that fires is named with its numbers', () => {
    const g = evaluateGuard(path({ realised: -9000, total: -9000, peak: 0, drawdownFromPeak: 9000, lossStreak: 4 }), cfg, none, null, now);
    expect(g.reasons).toEqual(['drawdown ₹9000 ≥ ₹5000', 'day loss ₹9000 ≥ ₹8000', '4 losers in a row ≥ 3']);
  });

  it('a limit of 0 is off, not always-on', () => {
    expect(evaluateGuard(path({}), { drawdownRupees: 0, dayLossRupees: 0, lossStreak: 3 }, none, null, now).blocked).toBe(false);
  });
});
