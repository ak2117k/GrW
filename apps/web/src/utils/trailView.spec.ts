import { describe, it, expect } from 'vitest';
import { trailView } from './trailView';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    currentBreakdown: null, initialAt: '', profitTarget: 110,
    profitTargetSource: 'fallback-2pct',
    stopLossScore: 50, status: 'WATCHING', currentPrice: null, currentScore: null,
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

function armedBuy(over: Partial<WatchEntry> = {}): WatchEntry {
  return entry({
    status: 'TRADED', side: 'BUY', executedPrice: 100,
    // WatchEntry.partialExitedAt is typed string | null; cast silences the literal-string check.
    partialExitedAt: '2026-05-20T05:00:00Z' as never,
    partialQty: 750, partialExitPrice: 104, remainingQty: 750,
    trailingHighWater: 106.8, trailingStopPrice: 106.27, currentPrice: 106.5,
    ...over,
  });
}

describe('trailView — state determination', () => {
  it('returns n/a for an entry that never executed', () => {
    const v = trailView(entry({ status: 'WATCHING', executedPrice: null }));
    expect(v.state).toBe('n/a');
    expect(v.slPrice).toBeNull();
  });

  it('returns n/a for an executed entry closed without partial exit', () => {
    const v = trailView(entry({
      status: 'STOPPED', executedPrice: 100, partialExitedAt: null,
    }));
    expect(v.state).toBe('n/a');
  });

  it('returns pending for a TRADED entry whose trail is not yet armed', () => {
    expect(trailView(entry({
      status: 'TRADED', executedPrice: 100, partialExitedAt: null,
    })).state).toBe('pending');
  });

  it('returns armed once the partial exit has fired', () => {
    expect(trailView(armedBuy()).state).toBe('armed');
  });

  it('returns armed for a closed entry that had a trail (final state)', () => {
    const v = trailView(armedBuy({ status: 'EXITED' }));
    expect(v.state).toBe('armed');
    // closed → SL column hides but the trail metrics are still present
    expect(v.slPrice).toBeNull();
    expect(v.trailStop).toBe(106.27);
  });
});

describe('trailView — SL column (pending: hard stop)', () => {
  it('BUY: hard stop = executedPrice × 0.996', () => {
    const v = trailView(entry({ status: 'TRADED', executedPrice: 100 }));
    expect(v.slKind).toBe('hard');
    expect(v.slPrice).toBeCloseTo(99.6, 4);
  });

  it('SELL: hard stop = executedPrice × 1.004', () => {
    const v = trailView(entry({ status: 'TRADED', side: 'SELL', executedPrice: 100 }));
    expect(v.slPrice).toBeCloseTo(100.4, 4);
  });

  it('pending also exposes the +1% arm price', () => {
    expect(trailView(entry({ status: 'TRADED', executedPrice: 100 })).armPrice)
      .toBeCloseTo(101, 4);
  });
});

describe('trailView — SL column (armed: trail stop)', () => {
  it('uses trailingStopPrice when armed and currently TRADED', () => {
    const v = trailView(armedBuy());
    expect(v.slKind).toBe('trail');
    expect(v.slPrice).toBe(106.27);
  });
});

describe('trailView — armed metrics (BUY)', () => {
  it('realised: (partialExitPrice − executedPrice) × side × partialQty', () => {
    // (104-100) * 1 * 750 = 3000
    expect(trailView(armedBuy()).realised).toBeCloseTo(3000, 4);
  });

  it('protected: (trailStop − executedPrice) × side × remainingQty', () => {
    // (106.27-100) * 1 * 750 = 4702.5
    expect(trailView(armedBuy()).protected).toBeCloseTo(4702.5, 4);
  });

  it('lockedTotal = realised + protected', () => {
    // 3000 + 4702.5 = 7702.5
    expect(trailView(armedBuy()).lockedTotal).toBeCloseTo(7702.5, 4);
  });

  it('distancePct: ((current − trailStop)/trailStop) × side × 100 — positive when price above stop', () => {
    // ((106.5-106.27)/106.27) * 100 ≈ 0.2164%
    expect(trailView(armedBuy()).distancePct).toBeCloseTo(0.2164, 3);
  });

  it('distancePct is null when currentPrice is null', () => {
    expect(trailView(armedBuy({ currentPrice: null })).distancePct).toBeNull();
  });

  it('protected and lockedTotal are null when trailStop is missing on an armed entry', () => {
    const v = trailView(armedBuy({ trailingStopPrice: null }));
    expect(v.protected).toBeNull();
    expect(v.lockedTotal).toBeNull();
    // realised is still computed from the partial-exit fields
    expect(v.realised).toBeCloseTo(3000, 4);
  });
});

describe('trailView — armed metrics (SELL)', () => {
  it('realised, protected, distancePct are favorable-positive on a SELL that fell', () => {
    const v = trailView(entry({
      status: 'TRADED', side: 'SELL', executedPrice: 100,
      // WatchEntry.partialExitedAt is typed string | null; cast silences the literal-string check.
      partialExitedAt: '2026-05-20T05:00:00Z' as never,
      partialQty: 500, partialExitPrice: 96, remainingQty: 500,
      trailingHighWater: 93.2, trailingStopPrice: 93.66, currentPrice: 93.5,
    }));
    // (96-100) * -1 * 500 = +2000
    expect(v.realised).toBeCloseTo(2000, 4);
    // (93.66-100) * -1 * 500 = +3170
    expect(v.protected).toBeCloseTo(3170, 4);
    // ((93.5-93.66)/93.66) * -1 * 100 ≈ +0.1708%
    expect(v.distancePct).toBeCloseTo(0.1708, 3);
  });
});
