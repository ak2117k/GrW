import {
  computeSummary,
  computeRealized,
  computeByScanner,
  computeByScoreBucket,
  computeByFactor,
  computeByDay,
  type StatWatch,
  type StatTrade,
} from './strategy-review.stats';

/**
 * Synthetic fixtures. Each "watch" is one WatchEntry row — every watched
 * Chartink alert, whether or not it ever became a trade. Each "trade" is a
 * paper Trade row linked to a watch via paperTradeId.
 *
 * Scenario (8 watch entries):
 *  - w1 Scanner A score 75 TARGET_HIT  BUY  executed -> t1 (+950 net)
 *  - w2 Scanner A score 55 STOPPED     BUY  executed -> t2 (-430 net)
 *  - w3 Scanner B score 82 TARGET_HIT  SELL executed -> t3 (+580 net)
 *  - w4 Scanner B score 65 STOPPED     BUY  not executed
 *  - w5 Scanner A score 70 WATCHING    BUY  not executed (open)
 *  - w6 Scanner B score 88 TRADED      BUY  executed -> t4 (still open) (open)
 *  - w7 Scanner A score 62 EXITED      BUY  not executed (counts in total only)
 *  - w8 Scanner A score 78 DISMISSED   SELL not executed (counts in total only)
 *
 * Resolved = TARGET_HIT + STOPPED = w1,w2,w3,w4 -> 4 (3 wins / 1 loss... see below)
 *   wins  = w1,w3   losses = w2,w4
 */

function trade(o: Partial<StatTrade> & { id: string }): StatTrade {
  return {
    id: o.id,
    status: o.status ?? 'CLOSED',
    pnl: o.pnl ?? 0,
    fees: o.fees ?? 0,
    entryTime: o.entryTime ?? new Date('2026-05-01T04:00:00Z'),
  };
}

function watch(o: Partial<StatWatch> & { id: string }): StatWatch {
  return {
    id: o.id,
    scanner: o.scanner ?? 'Scanner A',
    side: o.side ?? 'BUY',
    status: o.status ?? 'WATCHING',
    initialScore: o.initialScore ?? 70,
    initialPrice: o.initialPrice ?? 100,
    maxFavorable: o.maxFavorable ?? null,
    maxAdverse: o.maxAdverse ?? null,
    initialAt: o.initialAt ?? new Date('2026-05-01T04:00:00Z'),
    paperTradeId: o.paperTradeId ?? null,
    checks: o.checks ?? [],
  };
}

// Linked paper trades.
const trades: StatTrade[] = [
  trade({ id: 't1', pnl: 1000, fees: 50 }), // net +950 winner
  trade({ id: 't2', pnl: -400, fees: 30 }), // net -430 loser
  trade({ id: 't3', pnl: 600, fees: 20 }), // net +580 winner
  trade({ id: 't4', status: 'OPEN', pnl: null, fees: 0 }), // open, not closed
];

const watches: StatWatch[] = [
  watch({
    id: 'w1',
    scanner: 'Scanner A',
    side: 'BUY',
    status: 'TARGET_HIT',
    initialScore: 75,
    initialPrice: 100,
    maxFavorable: 115, // BUY favorable -> +15%
    maxAdverse: 98, //   BUY adverse   -> -2%
    paperTradeId: 't1',
    initialAt: new Date('2026-05-01T04:00:00Z'), // 2026-05-01 IST
    checks: [
      { name: 'aboveVwap', passed: true },
      { name: 'macdAligned', passed: true },
    ],
  }),
  watch({
    id: 'w2',
    scanner: 'Scanner A',
    side: 'BUY',
    status: 'STOPPED',
    initialScore: 55,
    initialPrice: 200,
    maxFavorable: 205, // +2.5%
    maxAdverse: 190, //  -5%
    paperTradeId: 't2',
    initialAt: new Date('2026-05-01T05:00:00Z'), // 2026-05-01 IST
    checks: [
      { name: 'aboveVwap', passed: false },
      { name: 'macdAligned', passed: true },
    ],
  }),
  watch({
    id: 'w3',
    scanner: 'Scanner B',
    side: 'SELL',
    status: 'TARGET_HIT',
    initialScore: 82,
    initialPrice: 300,
    maxFavorable: 280, // SELL favorable (price drop) -> +6.6667%
    maxAdverse: 310, //  SELL adverse   (price rise) -> -3.3333%
    paperTradeId: 't3',
    initialAt: new Date('2026-05-02T06:00:00Z'), // 2026-05-02 IST
    checks: [
      { name: 'aboveVwap', passed: true },
      { name: 'macdAligned', passed: false },
    ],
  }),
  watch({
    id: 'w4',
    scanner: 'Scanner B',
    side: 'BUY',
    status: 'STOPPED',
    initialScore: 65,
    initialPrice: 150,
    maxFavorable: 153, // +2%
    maxAdverse: 144, //  -4%
    paperTradeId: null,
    initialAt: new Date('2026-05-02T07:00:00Z'), // 2026-05-02 IST
    checks: [
      { name: 'aboveVwap', passed: false },
      { name: 'macdAligned', passed: false },
    ],
  }),
  watch({
    id: 'w5',
    scanner: 'Scanner A',
    side: 'BUY',
    status: 'WATCHING',
    initialScore: 70,
    initialPrice: 120,
    maxFavorable: null,
    maxAdverse: null,
    paperTradeId: null,
    initialAt: new Date('2026-05-02T08:00:00Z'), // 2026-05-02 IST
    checks: [{ name: 'aboveVwap', passed: true }],
  }),
  watch({
    id: 'w6',
    scanner: 'Scanner B',
    side: 'BUY',
    status: 'TRADED',
    initialScore: 88,
    initialPrice: 80,
    maxFavorable: 84,
    maxAdverse: 79,
    paperTradeId: 't4', // executed, trade still OPEN
    initialAt: new Date('2026-05-02T09:00:00Z'), // 2026-05-02 IST
    checks: [{ name: 'aboveVwap', passed: true }],
  }),
  watch({
    id: 'w7',
    scanner: 'Scanner A',
    side: 'BUY',
    status: 'EXITED',
    initialScore: 62,
    initialPrice: 90,
    maxFavorable: 92,
    maxAdverse: 88,
    paperTradeId: null,
    initialAt: new Date('2026-05-02T09:30:00Z'), // 2026-05-02 IST
    checks: [{ name: 'aboveVwap', passed: false }],
  }),
  // UTC timestamp that crosses the IST date boundary: 2026-05-02T19:00:00Z
  // + 5:30 = 2026-05-03T00:30 IST -> grouped under 2026-05-03.
  watch({
    id: 'w8',
    scanner: 'Scanner A',
    side: 'SELL',
    status: 'DISMISSED',
    initialScore: 78,
    initialPrice: 50,
    maxFavorable: null,
    maxAdverse: null,
    paperTradeId: null,
    initialAt: new Date('2026-05-02T19:00:00Z'), // 2026-05-03 IST
    checks: [{ name: 'aboveVwap', passed: true }],
  }),
];

describe('computeSummary', () => {
  it('aggregates all watched alerts, resolution and side-adjusted MFE/MAE', () => {
    const s = computeSummary(watches);
    expect(s.watchEntries).toBe(8);
    // resolved = TARGET_HIT + STOPPED = w1,w2,w3,w4
    expect(s.resolved).toBe(4);
    expect(s.wins).toBe(2); // w1,w3
    expect(s.losses).toBe(2); // w2,w4
    // open = WATCHING + TRADED = w5,w6
    expect(s.open).toBe(2);
    expect(s.winRate).toBe(50); // 2/4*100
    // executed = entries with paperTradeId = w1,w2,w3,w6
    expect(s.executed).toBe(4);
    // avgMfePct over all watches with maxFavorable present (w1,w2,w3,w4,w6,w7):
    //  w1 BUY  (115-100)/100 = 15
    //  w2 BUY  (205-200)/200 = 2.5
    //  w3 SELL (280-300)/300*-1 = 6.6667
    //  w4 BUY  (153-150)/150 = 2
    //  w6 BUY  (84-80)/80 = 5
    //  w7 BUY  (92-90)/90 = 2.2222
    // avg = (15+2.5+6.6667+2+5+2.2222)/6 = 5.5648
    expect(s.avgMfePct).toBeCloseTo(5.5648, 3);
    // avgMaePct over w1,w2,w3,w4,w6,w7 (negative = adverse):
    //  w1 BUY  (98-100)/100 = -2
    //  w2 BUY  (190-200)/200 = -5
    //  w3 SELL (310-300)/300*-1 = -3.3333
    //  w4 BUY  (144-150)/150 = -4
    //  w6 BUY  (79-80)/80 = -1.25
    //  w7 BUY  (88-90)/90 = -2.2222
    // avg = (-2-5-3.3333-4-1.25-2.2222)/6 = -2.9676
    expect(s.avgMaePct).toBeCloseTo(-2.9676, 3);
  });

  it('handles empty input with no divide-by-zero', () => {
    const s = computeSummary([]);
    expect(s.watchEntries).toBe(0);
    expect(s.resolved).toBe(0);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.open).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.executed).toBe(0);
    expect(s.avgMfePct).toBe(0);
    expect(s.avgMaePct).toBe(0);
  });
});

describe('computeRealized', () => {
  it('aggregates only executed paper trades, kept separate from watch stats', () => {
    const r = computeRealized(watches, trades);
    // closed trades linked via executed watches: t1,t2,t3 (t4 is OPEN)
    expect(r.closedTrades).toBe(3);
    expect(r.winners).toBe(2); // t1 net +950, t3 net +580
    expect(r.winRate).toBeCloseTo(66.67, 1); // 2/3
    expect(r.grossPnl).toBe(1200); // 1000 - 400 + 600
    expect(r.fees).toBe(100); // 50 + 30 + 20
    expect(r.netPnl).toBe(1100); // 1200 - 100
    expect(r.expectancy).toBeCloseTo(366.67, 1); // 1100 / 3
  });

  it('handles empty input with no divide-by-zero', () => {
    const r = computeRealized([], []);
    expect(r.closedTrades).toBe(0);
    expect(r.winners).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.grossPnl).toBe(0);
    expect(r.fees).toBe(0);
    expect(r.netPnl).toBe(0);
    expect(r.expectancy).toBe(0);
  });

  it('ignores trades whose watch is not executed / not linked', () => {
    // A closed trade with NO watch pointing at it must not be counted.
    const orphan = [trade({ id: 'orphan', pnl: 9999, fees: 1 })];
    const r = computeRealized([], orphan);
    expect(r.closedTrades).toBe(0);
    expect(r.netPnl).toBe(0);
  });
});

describe('computeByScanner', () => {
  it('groups every watch entry by scanner over resolved entries', () => {
    const rows = computeByScanner(watches);
    const a = rows.find((r) => r.scanner === 'Scanner A')!;
    const b = rows.find((r) => r.scanner === 'Scanner B')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Scanner A entries: w1,w2,w5,w7,w8 -> 5
    expect(a.entries).toBe(5);
    // resolved on A: w1(TARGET_HIT),w2(STOPPED) -> 2
    expect(a.resolved).toBe(2);
    expect(a.wins).toBe(1); // w1
    expect(a.winRate).toBe(50); // 1/2
    expect(a.executed).toBe(2); // w1,w2 have paperTradeId
    // avgMfePct over A watches with maxFavorable: w1(15),w2(2.5),w7(2.2222) = 6.5741
    expect(a.avgMfePct).toBeCloseTo(6.5741, 3);
    // avgMaePct: w1(-2),w2(-5),w7(-2.2222) = -3.0741
    expect(a.avgMaePct).toBeCloseTo(-3.0741, 3);

    // Scanner B entries: w3,w4,w6 -> 3
    expect(b.entries).toBe(3);
    expect(b.resolved).toBe(2); // w3,w4
    expect(b.wins).toBe(1); // w3
    expect(b.winRate).toBe(50);
    expect(b.executed).toBe(2); // w3,w6
  });

  it('returns empty array for empty input', () => {
    expect(computeByScanner([])).toEqual([]);
  });
});

describe('computeByScoreBucket', () => {
  it('buckets every watch entry by initialScore over resolved entries', () => {
    const rows = computeByScoreBucket(watches);
    expect(rows.map((r) => r.bucket)).toEqual([
      '50-59',
      '60-69',
      '70-79',
      '80+',
    ]);
    const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));

    // 50-59: w2(55) -> 1 entry, resolved 1, win 0
    expect(byBucket['50-59'].entries).toBe(1);
    expect(byBucket['50-59'].resolved).toBe(1);
    expect(byBucket['50-59'].wins).toBe(0);
    expect(byBucket['50-59'].winRate).toBe(0);

    // 60-69: w4(65), w7(62) -> 2 entries, resolved 1 (w4 STOPPED), win 0
    expect(byBucket['60-69'].entries).toBe(2);
    expect(byBucket['60-69'].resolved).toBe(1);
    expect(byBucket['60-69'].wins).toBe(0);

    // 70-79: w1(75), w5(70), w8(78) -> 3 entries, resolved 1 (w1), win 1
    expect(byBucket['70-79'].entries).toBe(3);
    expect(byBucket['70-79'].resolved).toBe(1);
    expect(byBucket['70-79'].wins).toBe(1);
    expect(byBucket['70-79'].winRate).toBe(100);

    // 80+: w3(82), w6(88) -> 2 entries, resolved 1 (w3), win 1
    expect(byBucket['80+'].entries).toBe(2);
    expect(byBucket['80+'].resolved).toBe(1);
    expect(byBucket['80+'].wins).toBe(1);
    expect(byBucket['80+'].winRate).toBe(100);
  });

  it('emits all four buckets even when empty', () => {
    const rows = computeByScoreBucket([]);
    expect(rows.map((r) => r.bucket)).toEqual([
      '50-59',
      '60-69',
      '70-79',
      '80+',
    ]);
    rows.forEach((r) => {
      expect(r.entries).toBe(0);
      expect(r.resolved).toBe(0);
      expect(r.wins).toBe(0);
      expect(r.winRate).toBe(0);
      expect(r.avgMfePct).toBe(0);
      expect(r.avgMaePct).toBe(0);
    });
  });
});

describe('computeByFactor', () => {
  it('computes pass/fail win-rates and edge over RESOLVED entries only', () => {
    const rows = computeByFactor(watches);
    const byFactor = Object.fromEntries(rows.map((r) => [r.factor, r]));
    expect(Object.keys(byFactor).sort()).toEqual(['aboveVwap', 'macdAligned']);

    // Resolved entries only: w1(win), w2(loss), w3(win), w4(loss).
    // aboveVwap: pass on w1(win), w3(win) ; fail on w2(loss), w4(loss)
    const av = byFactor['aboveVwap'];
    expect(av.passResolved).toBe(2);
    expect(av.passWins).toBe(2);
    expect(av.passWinRate).toBe(100);
    expect(av.failResolved).toBe(2);
    expect(av.failWins).toBe(0);
    expect(av.failWinRate).toBe(0);
    expect(av.edge).toBe(100);

    // macdAligned: pass on w1(win), w2(loss) ; fail on w3(win), w4(loss)
    const mc = byFactor['macdAligned'];
    expect(mc.passResolved).toBe(2);
    expect(mc.passWins).toBe(1);
    expect(mc.passWinRate).toBe(50);
    expect(mc.failResolved).toBe(2);
    expect(mc.failWins).toBe(1);
    expect(mc.failWinRate).toBe(50);
    expect(mc.edge).toBe(0);
  });

  it('returns empty array for empty input', () => {
    expect(computeByFactor([])).toEqual([]);
  });
});

describe('computeByDay', () => {
  it('groups watch entries by IST initialAt date, sorted descending', () => {
    const rows = computeByDay(watches, trades);
    // Days: 2026-05-01 (w1,w2), 2026-05-02 (w3,w4,w5,w6,w7),
    //       2026-05-03 (w8 — crosses IST boundary)
    expect(rows.map((r) => r.date)).toEqual([
      '2026-05-03',
      '2026-05-02',
      '2026-05-01',
    ]);
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));

    // 2026-05-01: w1(TARGET_HIT,exec t1), w2(STOPPED,exec t2)
    const d1 = byDate['2026-05-01'];
    expect(d1.entries).toBe(2);
    expect(d1.resolved).toBe(2);
    expect(d1.wins).toBe(1); // w1
    expect(d1.winRate).toBe(50);
    expect(d1.executed).toBe(2);
    // realizedNetPnl = closed trades entered... no: linked to watches that day.
    // t1 net +950, t2 net -430 -> 520
    expect(d1.realizedNetPnl).toBe(520);

    // 2026-05-02: w3(TARGET_HIT,exec t3), w4(STOPPED), w5(WATCHING),
    //             w6(TRADED,exec t4 open), w7(EXITED)
    const d2 = byDate['2026-05-02'];
    expect(d2.entries).toBe(5);
    expect(d2.resolved).toBe(2); // w3,w4
    expect(d2.wins).toBe(1); // w3
    expect(d2.winRate).toBe(50);
    expect(d2.executed).toBe(2); // w3,w6
    // realized: t3 closed net +580, t4 OPEN -> excluded -> 580
    expect(d2.realizedNetPnl).toBe(580);

    // 2026-05-03: w8(DISMISSED)
    const d3 = byDate['2026-05-03'];
    expect(d3.entries).toBe(1);
    expect(d3.resolved).toBe(0);
    expect(d3.wins).toBe(0);
    expect(d3.winRate).toBe(0);
    expect(d3.executed).toBe(0);
    expect(d3.realizedNetPnl).toBe(0);
  });

  it('returns empty array for empty input', () => {
    expect(computeByDay([], [])).toEqual([]);
  });
});
