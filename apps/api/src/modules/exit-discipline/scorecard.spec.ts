import { scorecard, scorecardLine } from './scorecard';

describe('scorecard', () => {
  const s = scorecard('2026-10-14', [
    { kind: 'EXECUTED', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190 },
    { kind: 'GATED', missedPnl: 900, savedPnl: 300, netAtEnd: 600 },
    { kind: 'GATED', missedPnl: 100, savedPnl: 800, netAtEnd: -500 },
    { kind: 'AWAITING', missedPnl: 50, savedPnl: 20, netAtEnd: 30 },
    { kind: 'DRY_RUN', missedPnl: 10, savedPnl: 5, netAtEnd: 1 },
  ]);
  it('aggregates by kind; the gate is credited with net moves it held through', () => {
    expect(s).toEqual({
      day: '2026-10-14',
      executed: { n: 1, missed: 1490, saved: 410 },
      dryRun: { n: 1, missed: 10, saved: 5 },
      gate: { blocked: 3, gated: 2, awaiting: 1, helped: 630, cost: 500, net: 130 },
    });
  });
  it('one log line', () => {
    expect(scorecardLine(s)).toBe(
      '[exit-score] 2026-10-14 executed=1 missed=₹1490 saved=₹410 | gate blocked=3 (gated 2, awaiting 1) helped=₹630 cost=₹500 net=₹130 | dry-run=1',
    );
  });
  it('an empty day is all zeros', () => {
    expect(scorecard('2026-10-15', []).gate).toEqual({ blocked: 0, gated: 0, awaiting: 0, helped: 0, cost: 0, net: 0 });
  });
});
