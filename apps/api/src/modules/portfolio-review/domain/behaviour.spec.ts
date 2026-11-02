import {
  aiVsManualExits,
  averagingDown,
  chargesDrag,
  concentration,
  deadHoldings,
  givingBack,
  losersHeldLonger,
  noStopEvidence,
  oversized,
  sameDayReentries,
} from './behaviour';
import { holdingCheck, trade } from './review.fixtures';
import type { Episode } from './types';

describe('behaviour patterns', () => {
  it('losers held longer than winners — ratio, overstayed losers and their loss', () => {
    const ts = [
      trade({ net: 500, holdingDays: 0.2 }),
      trade({ net: 400, holdingDays: 0.3 }),
      trade({ net: 300, holdingDays: 0.4 }),
      trade({ net: -1000, holdingDays: 3 }),
      trade({ net: -2000, holdingDays: 5 }),
      trade({ net: -100, holdingDays: 0.1 }),
    ];
    const p = losersHeldLonger(ts);
    expect(p.evidence.winnersAvgDays).toBeCloseTo(0.3, 1);
    expect(p.evidence.losersAvgDays).toBeCloseTo(2.7, 1);
    expect(p.severity).toBe('HIGH');
    expect(p.evidence.overstayed).toBe(2);
    expect(p.rupees).toBe(3000);
  });
  it('losers held longer is OK with too few trades', () => {
    expect(losersHeldLonger([trade({ net: 10 }), trade({ net: -10, holdingDays: 9 })]).severity).toBe('OK');
  });

  it('no stop: deep option losses and expiry, with the illustrative −30% cap', () => {
    const ts = [
      trade({ net: -6000, returnPct: -80, entryPrice: 100, qty: 75 }), // premium 7,500 → −30% = −2,250
      trade({ net: -500, returnPct: -10 }),
      trade({ net: -3000, closedBy: 'EXPIRY', returnPct: -40, entryPrice: 50, qty: 75 }),
      trade({ net: -900, segment: 'FUTURES', derivative: null, returnPct: -12 }),
    ];
    const p = noStopEvidence(ts);
    expect(p.evidence.trades).toBe(3);
    expect(p.rupees).toBe(9900);
    expect(p.evidence.optionTrades).toBe(2);
    expect(p.evidence.illustrativeSaving).toBeCloseTo(9000 - (2250 + 1125), 2);
  });

  it('giving back: peak ≥ ₹500 and kept ≤ half; trail-half-peak counterfactual', () => {
    const ts = [
      trade({ net: -200, realisedGross: -200, peakOpenProfit: 3000, gaveBack: 3200 }),
      trade({ net: 2800, realisedGross: 2800, peakOpenProfit: 3000, gaveBack: 200 }),
      trade({ net: 100, realisedGross: 100, peakOpenProfit: 300, gaveBack: 200 }),
    ];
    const p = givingBack(ts);
    expect(p.evidence.trades).toBe(1);
    expect(p.evidence.gaveBack).toBe(3200);
    expect(p.rupees).toBe(1700); // 0.5 × 3000 − (−200)
    expect(p.evidence.turnedToLoss).toBe(1);
  });

  it('averaging down: open and closed outcomes', () => {
    const ep = (over: Partial<Episode>) => ({ ...trade({}), ...over }) as Episode;
    const open = ep({ key: 'a', status: 'OPEN', averagedDown: true, unrealised: -5000, realisedGross: 0, charges: 0 });
    const closed = ep({ key: 'b', status: 'CLOSED', averagedDown: true });
    const p = averagingDown([open, closed, ep({ key: 'c' })], [trade({ key: 'b', net: -1000 })]);
    expect(p.evidence.count).toBe(2);
    expect(p.evidence.netOutcome).toBe(-6000);
    expect(p.rupees).toBe(6000);
  });

  it('same-day re-entries on one contract', () => {
    const ts = [
      trade({ token: 'X', firstEntry: '2026-10-01T04:00:00.000Z', net: -100 }),
      trade({ token: 'X', firstEntry: '2026-10-01T06:00:00.000Z', net: -400 }),
      trade({ token: 'X', firstEntry: '2026-10-01T08:00:00.000Z', net: 100 }),
      trade({ token: 'X', firstEntry: '2026-10-02T04:00:00.000Z', net: -999 }),
    ];
    const p = sameDayReentries(ts);
    expect(p.evidence.reentries).toBe(2);
    expect(p.evidence.net).toBe(-300);
  });

  it('oversized trades only count when they do worse per trade than normal ones', () => {
    const normal = Array.from({ length: 5 }, () => trade({ entryNotional: 10_000, net: -100 }));
    const bigBad = [trade({ entryNotional: 50_000, net: -5000 })];
    const p = oversized([...normal, ...bigBad]);
    expect(p.evidence.trades).toBe(1);
    expect(p.rupees).toBe(5000);
    const bigFine = oversized([...normal, trade({ entryNotional: 50_000, net: -50 })]);
    expect(bigFine.rupees).toBe(0);
    expect(bigFine.severity).toBe('LOW');
  });

  it('concentration, dead holdings', () => {
    const hs = [
      holdingCheck({ symbol: 'A', sharePct: 30, cost: 30000, pnlPct: -25, pnl: -7500, tags: ['DEAD-MONEY', 'CONCENTRATED'] }),
      holdingCheck({ symbol: 'B', sharePct: 20, cost: 20000 }),
      holdingCheck({ symbol: 'C', sharePct: 10, cost: 10000 }),
    ];
    const c = concentration(hs);
    expect(c.severity).toBe('HIGH');
    expect(c.evidence.top3Pct).toBe(60);
    const d = deadHoldings(hs);
    expect(d.evidence.holdings).toBe(1);
    expect(d.rupees).toBe(7500);
  });

  it('who closed the F&O trades, and charges drag', () => {
    const ts = [
      trade({ closedBy: 'AI_EXIT', net: -100, charges: 50, realisedGross: -50 }),
      trade({ closedBy: 'AT_BROKER', net: 300, charges: 50, realisedGross: 350 }),
      trade({ closedBy: 'EXPIRY', net: -1000, charges: 50, realisedGross: -950 }),
    ];
    const a = aiVsManualExits(ts);
    expect(a.evidence).toMatchObject({ aiTrades: 1, aiNet: -100, brokerTrades: 1, expiryTrades: 1, expiryNet: -1000 });
    const c = chargesDrag(ts);
    expect(c.evidence.charges).toBe(150);
    expect(c.evidence.pctOfGross).toBeCloseTo(23.1, 1);
    expect(c.severity).toBe('MEDIUM');
  });
});
