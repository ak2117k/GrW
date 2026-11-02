import { buildEpisodes } from './episodes';
import { bucketize, computeBreakdowns, computeHeadline, dteBucket, entryTimeBucket, holdingBucket, premiumBucket, toClosedTrades } from './metrics';
import { closedPos, holdingRow, ist, trade } from './review.fixtures';

const NOW = ist('2026-11-02 13:00');

describe('buckets', () => {
  it('entry-time windows in IST', () => {
    expect(entryTimeBucket(ist('2026-10-01 09:20'))).toBe('09:15-10:00');
    expect(entryTimeBucket(ist('2026-10-01 11:59'))).toBe('10:00-12:00');
    expect(entryTimeBucket(ist('2026-10-01 15:10'))).toBe('14:00-15:30');
    expect(entryTimeBucket(ist('2026-10-01 19:30'))).toBe('after 15:30 (MCX evening)');
  });
  it('holding period: same IST day, ≤5 days, longer', () => {
    expect(holdingBucket(ist('2026-10-01 09:20').toISOString(), ist('2026-10-01 15:00').toISOString())).toBe('INTRADAY');
    expect(holdingBucket(ist('2026-10-01 15:20').toISOString(), ist('2026-10-03 10:00').toISOString())).toBe('1-5D');
    expect(holdingBucket(ist('2026-10-01 15:20').toISOString(), ist('2026-10-20 10:00').toISOString())).toBe('>5D');
  });
  it('DTE and premium-to-strike buckets', () => {
    expect(dteBucket(0)).toBe('0 (expiry day)');
    expect(dteBucket(2)).toBe('1-2 days');
    expect(dteBucket(5)).toBe('3-7 days');
    expect(dteBucket(20)).toBe('8-30 days');
    expect(dteBucket(45)).toBe('>30 days');
    expect(premiumBucket(0.2)).toMatch(/far OTM/);
    expect(premiumBucket(1)).toMatch(/near OTM/);
    expect(premiumBucket(3)).toMatch(/ATM/);
  });
  it('bucketize sums, counts wins/losses and sorts worst first', () => {
    const b = bucketize([trade({ net: 100, segment: 'OPTIONS' }), trade({ net: -300, segment: 'OPTIONS' }), trade({ net: -50, segment: 'COMMODITY' })], (t) => t.segment);
    expect(b.map((x) => x.key)).toEqual(['OPTIONS', 'COMMODITY']);
    expect(b[0]).toMatchObject({ trades: 2, wins: 1, losses: 1, net: -200, winRate: 50, avgNet: -100 });
  });
});

describe('headline', () => {
  const rows = [
    closedPos('KEI29SEP265800CE', 271.85, 0.05, 175, '2026-08-17 14:10', '2026-09-30 15:50'),
    closedPos('POLICYBZR29SEP261560PE', 221.05, 394, 350, '2026-09-24 14:30', '2026-09-25 15:00'),
    closedPos('NIFTY28JUL2623950CE', 112.08, 84.45, 650, '2026-07-27 09:40', '2026-07-27 10:00'),
    holdingRow('IDEA-EQ', 13.11, 100, '2026-07-11 18:41', null, 12.25),
    holdingRow('SHADOWFAX-EQ', 231.12, 100, '2026-07-11 18:41', null, 270.7),
  ];
  const built = buildEpisodes(rows, [], [], NOW);
  const trades = toClosedTrades(built.episodes);
  const h = computeHeadline(trades, built.episodes);

  it('realised = Σ gross, charges estimated, net = gross − charges', () => {
    const gross = (0.05 - 271.85) * 175 + (394 - 221.05) * 350 + (84.45 - 112.08) * 650;
    expect(h.realisedGross).toBeCloseTo(gross, 1);
    expect(h.charges).toBeGreaterThan(60); // 3 option round trips: ≥ ₹40 brokerage each + STT + txn
    expect(h.realisedNet).toBeCloseTo(h.realisedGross - h.charges, 2);
  });
  it('unrealised from open holdings at LTP; total = realised net + unrealised', () => {
    expect(h.unrealisedHoldings).toBeCloseTo((12.25 - 13.11) * 100 + (270.7 - 231.12) * 100, 2);
    expect(h.total).toBeCloseTo(h.realisedNet + h.unrealised, 2);
    expect(h.holdingsCost).toBeCloseTo(1311 + 23112, 2);
    expect(h.openHoldings).toBe(2);
  });
  it('win rate, average win / loss, profit factor, largest losses, months', () => {
    expect(h.trades).toBe(3);
    expect(h.wins).toBe(1);
    expect(h.losses).toBe(2);
    expect(h.winRate).toBeCloseTo(33.3, 1);
    expect(h.avgWin).toBeGreaterThan(60000);
    expect(h.avgLoss).toBeLessThan(-30000);
    expect(h.profitFactor).toBeGreaterThan(0.9);
    expect(h.profitFactor).toBeLessThan(1.1);
    expect(h.largestLosses[0].symbol).toBe('KEI29SEP265800CE');
    expect(h.largestLosses[0].closedBy).toBe('EXPIRY');
    expect(h.byMonth.map((m) => m.month)).toEqual(['2026-07', '2026-09']);
    expect(h.trackedSince).toBe('2026-07-11');
  });
  it('breakdowns by option DTE, type and holding period', () => {
    const b = computeBreakdowns(trades);
    expect(b.byOptionType.map((x) => x.key).sort()).toEqual(['CE', 'PE']);
    expect(b.byClosedBy.find((x) => x.key === 'EXPIRY')?.trades).toBe(1);
    expect(b.byHoldingPeriod.find((x) => x.key === '>5D')?.trades).toBe(1);
    expect(b.byOptionDte.find((x) => x.key === '>30 days')?.trades).toBe(1);
  });
  it('a partly sold open holding contributes its realised part as a trade', () => {
    const r = [
      holdingRow('KALYANKJIL-EQ', 531, 100, '2026-07-14 10:00', '2026-08-01 10:00', 560),
      holdingRow('KALYANKJIL-EQ', 531.87, 15, '2026-08-01 10:10', null, 504.6),
    ];
    const ts = toClosedTrades(buildEpisodes(r, [], [], NOW).episodes);
    expect(ts).toHaveLength(1);
    expect(ts[0].realisedGross).toBeCloseTo((560 - 531) * 85, 2);
    expect(ts[0].closedBy).toBeNull();
  });
  it('peak open profit and giveback from holdingHigh', () => {
    const [t] = toClosedTrades(
      buildEpisodes([closedPos('CRUDEOIL15OCT268550PE', 494.3, 277, 100, '2026-09-23 15:00', '2026-09-24 14:30', { exchange: 'MCX', holdingHigh: 560 })], [], [], NOW).episodes,
    );
    expect(t.peakOpenProfit).toBeCloseTo((560 - 494.3) * 100, 2);
    expect(t.gaveBack).toBeCloseTo((560 - 494.3) * 100 - (277 - 494.3) * 100, 2);
  });
});
