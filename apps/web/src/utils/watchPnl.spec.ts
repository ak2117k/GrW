import { describe, it, expect } from 'vitest';
import {
  sectionTotalPnl, pnlBreakdown, breakdownChecks, profitView, accountRealPnl, whatIfView,
  dayRealizedSummary,
} from './watchPnl';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    currentBreakdown: null, initialAt: '', profitTarget: 110,
    profitTargetSource: 'fallback-2pct',
    stopLossScore: 60, status: 'WATCHING', currentPrice: null, currentScore: null,
    maxFavorable: null, maxAdverse: null, lastTickAt: null, lastRescoreAt: null,
    optionsToken: null, optionsType: null, optionsExpiry: null, optionsStrike: null,
    optionsLotSize: null, optionsSelectionScore: null, paperTradeId: null,
    liveTradeId: null, executedAt: null, executedPrice: null, quantity: null, closedAt: null,
    closedReason: null, notes: null, partialExitedAt: null, partialExitPrice: null,
    partialQty: null, remainingQty: null, trailingHighWater: null,
    trailingStopPrice: null, scannerName: null, realizedPnl: null,
    realizedFees: null,
    createdAt: '', updatedAt: '', ...o,
  };
}

describe('dayRealizedSummary', () => {
  it('sums realised pnl + fees across closed entries, exposes net = gross - charges', () => {
    const e1 = entry({ status: 'TARGET_HIT', realizedPnl: 2010, realizedFees: 105 });
    const e2 = entry({ status: 'STOPPED',    realizedPnl: -859,  realizedFees: 117 });
    const e3 = entry({ status: 'EXITED',     realizedPnl: 662,   realizedFees: 95  });
    const summary = dayRealizedSummary([e1, e2, e3]);
    expect(summary.count).toBe(3);
    expect(summary.gross).toBe(2010 - 859 + 662);
    expect(summary.charges).toBe(105 + 117 + 95);
    expect(summary.net).toBe(summary.gross - summary.charges);
  });

  it('skips open (TRADED) and never-traded what-if rows — only realised contributes', () => {
    const open = entry({ status: 'TRADED', realizedPnl: null });          // not closed yet
    const noTrade = entry({ status: 'STOPPED', realizedPnl: null });      // never executed
    const real = entry({ status: 'TARGET_HIT', realizedPnl: 500, realizedFees: 50 });
    const summary = dayRealizedSummary([open, noTrade, real]);
    expect(summary.count).toBe(1);
    expect(summary.gross).toBe(500);
    expect(summary.charges).toBe(50);
    expect(summary.net).toBe(450);
  });

  it('null realizedFees degrades to gross-only — never NaN', () => {
    const legacy = entry({ status: 'STOPPED', realizedPnl: -300, realizedFees: null });
    const summary = dayRealizedSummary([legacy]);
    expect(summary.charges).toBe(0);
    expect(summary.net).toBe(-300);
    expect(Number.isNaN(summary.net)).toBe(false);
  });

  it('empty list yields all zeros (no division-by-anything noise)', () => {
    expect(dayRealizedSummary([])).toEqual({ count: 0, gross: 0, charges: 0, net: 0 });
  });
});

describe('sectionTotalPnl', () => {
  it('open entries contribute live price-based P/L', () => {
    // TRADED, executed @100, live 105, qty floor(200000/100)=2000 → +10,000
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    expect(sectionTotalPnl([e])).toBeCloseTo(10000, 0);
  });

  it('closed entries contribute realized pnl, not price estimate', () => {
    const e = entry({ status: 'TARGET_HIT', executedPrice: 100, currentPrice: 999, realizedPnl: 4200 });
    expect(sectionTotalPnl([e])).toBe(4200);
  });

  it('closed entry that never traded contributes its what-if P/L (matches the column)', () => {
    // STOPPED, never executed (realizedPnl null), price moved 100 → 105.
    // score 60 -> ₹1L tier, qty = floor(100000/100) = 1000,
    // raw = (105-100)*1000 = 5000; within bounds; minus charges 82.41 -> 4917.59
    const e = entry({ status: 'STOPPED', initialPrice: 100, currentPrice: 105, realizedPnl: null });
    expect(sectionTotalPnl([e])).toBeCloseTo(4917.59, 1);
  });

  it('closed entry that never traded and never moved contributes ₹0', () => {
    const e = entry({ status: 'STOPPED', initialPrice: 100, currentPrice: null, realizedPnl: null });
    expect(sectionTotalPnl([e])).toBe(0);
  });

  it('sums a mixed section', () => {
    const open = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }); // +10,000
    const closed = entry({ status: 'STOPPED', realizedPnl: -1500 });
    expect(sectionTotalPnl([open, closed])).toBeCloseTo(8500, 0);
  });

  it('a MISSED entry shows its what-if P/L in the column (so missed amount is visible)', () => {
    // score 60 -> ₹1L, qty=1000, raw=(110-100)*1000=10000, capped at target 110,
    // minus charges 82.41 -> 9917.59 — same bounded what-if as a never-traded row.
    const missed = entry({ status: 'MISSED', initialPrice: 100, currentPrice: 110, realizedPnl: null });
    expect(sectionTotalPnl([missed])).toBeCloseTo(9917.59, 1);
  });
});

describe('pnlBreakdown', () => {
  it('separates realized, open (live), and what-if', () => {
    const realized = entry({ status: 'STOPPED', realizedPnl: -1500 });
    const open = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }); // +10,000
    const untraded = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 103 }); // bounded what-if
    const b = pnlBreakdown([realized, open, untraded]);
    expect(b.realized).toBe(-1500);
    expect(b.open).toBeCloseTo(10000, 0);
    expect(b.whatIf).toBeCloseTo(2917.59, 1);
    expect(b.real).toBeCloseTo(8500, 0); // realized + open, excludes what-if
  });

  it('a MISSED entry lands in its own `missed` bucket — visible, but never in real', () => {
    // MISSED = alert reached its level but was never executable (gate-rejected).
    // Its what-if P&L is tracked under `missed` so it is visible, but it stays
    // out of realized/open/whatIf and therefore out of Real P/L.
    const missed = entry({ status: 'MISSED', initialPrice: 100, currentPrice: 110, realizedPnl: null });
    const b = pnlBreakdown([missed]);
    expect(b.missed).toBeCloseTo(9917.59, 1);
    expect(b.realized).toBe(0);
    expect(b.open).toBe(0);
    expect(b.whatIf).toBe(0);
    expect(b.real).toBe(0);
  });

  it('counts a DISMISSED never-traded entry as what-if, never as real', () => {
    // DISMISSED, never traded: score 60 -> ₹1L, qty=1000, raw=(110-100)*1000=10000,
    // exactly at the cap (profitTarget 110), minus charges 82.41 -> 9917.59
    const dismissed = entry({ status: 'DISMISSED', initialPrice: 100, currentPrice: 110, realizedPnl: null });
    const b = pnlBreakdown([dismissed]);
    expect(b.whatIf).toBeCloseTo(9917.59, 1);
    expect(b.real).toBe(0);
  });

  it('real + whatIf equals sectionTotalPnl (same buckets, just split)', () => {
    const mixed = [
      entry({ status: 'TARGET_HIT', executedPrice: 100, currentPrice: 999, realizedPnl: 4200 }),
      entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }),
      entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 103 }),
    ];
    const b = pnlBreakdown(mixed);
    expect(b.real + b.whatIf).toBeCloseTo(sectionTotalPnl(mixed), 0);
  });

  it('uses the account unrealized P&L for the open slice when provided', () => {
    const realizedTrade = entry({ status: 'STOPPED', realizedPnl: -1800 });
    // The watch-entry currentPrice would estimate open at +10,000, but that
    // is stale (WebSocket-fed). The paper account's REST-priced figure (+2,105)
    // is authoritative and must replace the watch-entry estimate.
    const openPos = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    const b = pnlBreakdown([realizedTrade, openPos], 2105);
    expect(b.open).toBe(2105);
    expect(b.real).toBe(-1800 + 2105); // realized + fresh open
  });

  it('falls back to the watch-entry open when no account value is given', () => {
    const openPos = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    expect(pnlBreakdown([openPos]).open).toBeCloseTo(10000, 0); // undefined
    expect(pnlBreakdown([openPos], null).open).toBeCloseTo(10000, 0); // null
  });
});

describe('profitView', () => {
  it('uses entry.quantity for the position size, not floor(MAX/price)', () => {
    // executedPrice 100 → the floor(200000/100) estimate would be 2000;
    // the real filled quantity is 1500.
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105, quantity: 1500 });
    const v = profitView(e);
    expect(v.qty).toBe(1500);
    expect(v.abs).toBeCloseTo(7500, 0); // (105-100) * 1500
  });

  it('uses remainingQty (trailing remainder) over the full quantity after a partial exit', () => {
    const e = entry({
      status: 'TRADED', executedPrice: 100, currentPrice: 105,
      quantity: 1500, remainingQty: 750,
    });
    expect(profitView(e).qty).toBe(750);
  });

  it('falls back to floor(MAX/price) when quantity is absent (legacy entry)', () => {
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105, quantity: null });
    expect(profitView(e).qty).toBe(2000); // floor(200000 / 100)
  });
});

describe('whatIfView — bounded counterfactual', () => {
  it('mid-range move: raw P&L within bounds, minus round-trip charges', () => {
    // score 60 -> ₹1L tier, qty floor(100000/100)=1000, capital 100000.
    // raw = (103-100)*1000 = 3000; within [floor -400, cap 10000].
    // charges on 100000 capital = 82.41 -> abs = 3000 - 82.41
    const e = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 103 });
    const v = whatIfView(e);
    expect(v.qty).toBe(1000);
    expect(v.abs).toBeCloseTo(2917.59, 1);
  });

  it('floors a deep loss at the −0.4%-of-capital stop, not the raw drawdown', () => {
    // raw = (90-100)*1000 = -10000, but floored at -0.4%*100000 = -400.
    // abs = -400 - 82.41
    const e = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 90 });
    const v = whatIfView(e);
    expect(v.abs).toBeCloseTo(-482.41, 1);
    expect(v.abs).toBeGreaterThan(-1000); // NOT the raw -10000
  });

  it('caps a runaway gain at the profit target', () => {
    // currentPrice 200 -> raw 100000, capped at (110-100)*1000 = 10000.
    // abs = 10000 - 82.41
    const e = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: 200, profitTarget: 110 });
    const v = whatIfView(e);
    expect(v.abs).toBeCloseTo(9917.59, 1);
  });

  it('sizes quantity by the score tier (R4), not a flat ₹2L', () => {
    // score 70 -> [65,75) tier -> ₹1.5L -> floor(150000/100) = 1500
    const e = entry({ status: 'WATCHING', initialScore: 70, initialPrice: 100, currentPrice: 100 });
    expect(whatIfView(e).qty).toBe(1500);
  });

  it('yields abs 0 when the alert has no current price (no opinion)', () => {
    const e = entry({ status: 'WATCHING', initialPrice: 100, currentPrice: null });
    const v = whatIfView(e);
    expect(v.abs).toBe(0);
    expect(v.hasLivePrice).toBe(false);
  });

  it('a SELL alert that fell in its favour shows a bounded gain', () => {
    // SELL, ref 100, current 97 -> raw (97-100)*-1*1000 = 3000; bounded; minus charges
    const e = entry({ status: 'WATCHING', side: 'SELL', initialPrice: 100, currentPrice: 97, profitTarget: 90 });
    expect(whatIfView(e).abs).toBeCloseTo(2917.59, 1);
  });
});

describe('accountRealPnl', () => {
  // equity = balance + deployedCapital + unrealizedPnl + pendingProfit
  const acct = {
    startingCapital: 2_000_000,
    balance: 1_500_000,
    deployedCapital: 480_000,
    unrealizedPnl: 3_000,
    pendingProfit: 12_000,
    equity: 1_995_000, // 1,500,000 + 480,000 + 3,000 + 12,000
  };

  it('total is equity minus starting capital — the authoritative account P&L', () => {
    expect(accountRealPnl(acct).total).toBe(-5_000); // 1,995,000 - 2,000,000
  });

  it('decomposes into realized + unrealized + pending, which sum to total', () => {
    const r = accountRealPnl(acct);
    expect(r.unrealized).toBe(3_000);
    expect(r.pending).toBe(12_000);
    expect(r.realized).toBe(-20_000); // balance + deployed - starting
    expect(r.realized + r.unrealized + r.pending).toBeCloseTo(r.total, 6);
  });
});

describe('breakdownChecks', () => {
  const checks = [{ name: 'Idx', passed: true }];

  it('reads the wrapped { checks: [...] } shape (initialBreakdown / new currentBreakdown)', () => {
    expect(breakdownChecks({ checks })).toEqual(checks);
  });

  it('reads a bare [...] array (legacy currentBreakdown shape)', () => {
    expect(breakdownChecks(checks)).toEqual(checks);
  });

  it('returns [] for null / undefined / malformed input', () => {
    expect(breakdownChecks(null)).toEqual([]);
    expect(breakdownChecks(undefined)).toEqual([]);
    expect(breakdownChecks({ foo: 1 })).toEqual([]);
  });
});
