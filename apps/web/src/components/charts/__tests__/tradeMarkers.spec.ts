import { describe, it, expect } from 'vitest';
import {
  buildTradeMarkers,
  entryGlyph,
  entryColor,
  resolveEntryQty,
  formatExitTooltip,
  ENTRY_BUY_COLOR,
  ENTRY_SELL_COLOR,
  EXIT_COLOR,
} from '../tradeMarkers';
import type { ChartTrade } from '@/services/chartTrades.service';

function trade(over: Partial<ChartTrade>): ChartTrade {
  return {
    tradeId: 't1',
    side: 'BUY',
    provenance: 'Manual',
    entry: { time: 1_000_000, price: 100, quantity: 50 },
    exits: [],
    ...over,
  };
}

describe('entryGlyph / entryColor', () => {
  it('uses ▲ + green for a long (BUY)', () => {
    expect(entryGlyph('BUY')).toBe('▲');
    expect(entryColor('BUY')).toBe(ENTRY_BUY_COLOR);
  });

  it('uses ▼ + red for a short (SELL), case-insensitively', () => {
    expect(entryGlyph('sell')).toBe('▼');
    expect(entryColor('SELL')).toBe(ENTRY_SELL_COLOR);
  });

  it('defaults to the long glyph for an unknown/empty side', () => {
    expect(entryGlyph('')).toBe('▲');
    expect(entryGlyph(undefined as unknown as string)).toBe('▲');
  });
});

describe('resolveEntryQty', () => {
  it('prefers the declared entry quantity', () => {
    expect(resolveEntryQty(50, 10, 40)).toBe(50);
  });

  it('reconstructs from sold + remaining when entry qty is unknown', () => {
    expect(resolveEntryQty(null, 10, 40)).toBe(50);
    expect(resolveEntryQty(0, 30, 20)).toBe(50);
  });
});

describe('formatExitTooltip', () => {
  it('shows sold/total, remaining and source', () => {
    expect(formatExitTooltip(20, 50, 30, 'Chartink (chartink-gated)')).toBe(
      'sold 20 / 50 · 30 remaining · src: Chartink (chartink-gated)',
    );
  });
});

describe('buildTradeMarkers', () => {
  it('emits one entry marker and one marker per exit', () => {
    const markers = buildTradeMarkers([
      trade({
        exits: [
          { time: 2_000_000, price: 110, quantitySold: 20, quantityRemaining: 30, reason: 'PARTIAL_EXIT' },
          { time: 3_000_000, price: 120, quantitySold: 30, quantityRemaining: 0, reason: 'TARGET_HIT' },
        ],
      }),
    ]);

    expect(markers).toHaveLength(3);

    const entry = markers[0];
    expect(entry.kind).toBe('entry');
    expect(entry.glyph).toBe('▲');
    expect(entry.timeMs).toBe(1_000_000);
    expect(entry.price).toBe(100);
    expect(entry.tooltip).toBe('Manual');
    expect(entry.key).toBe('t1:entry');

    const [, e1, e2] = markers;
    expect(e1.kind).toBe('exit');
    expect(e1.glyph).toBe('●');
    expect(e1.color).toBe(EXIT_COLOR);
    // "sold X / entryQty" uses the entry's declared quantity (50).
    expect(e1.tooltip).toBe('sold 20 / 50 · 30 remaining · src: Manual');
    expect(e2.tooltip).toBe('sold 30 / 50 · 0 remaining · src: Manual');
    expect(e1.key).toBe('t1:exit:0');
    expect(e2.key).toBe('t1:exit:1');
  });

  it('cumulative remaining maths hold across multiple partial exits', () => {
    const markers = buildTradeMarkers([
      trade({
        side: 'SELL',
        entry: { time: 1_000_000, price: 200, quantity: 90 },
        exits: [
          { time: 2_000_000, price: 190, quantitySold: 30, quantityRemaining: 60, reason: 'PARTIAL_EXIT' },
          { time: 3_000_000, price: 180, quantitySold: 30, quantityRemaining: 30, reason: 'PARTIAL_EXIT' },
          { time: 4_000_000, price: 170, quantitySold: 30, quantityRemaining: 0, reason: 'CLOSED' },
        ],
      }),
    ]);
    expect(markers[0].glyph).toBe('▼'); // SELL entry
    expect(markers.slice(1).map((m) => m.tooltip)).toEqual([
      'sold 30 / 90 · 60 remaining · src: Manual',
      'sold 30 / 90 · 30 remaining · src: Manual',
      'sold 30 / 90 · 0 remaining · src: Manual',
    ]);
  });

  it('skips the entry marker when entry is null but still emits exits (total reconstructed)', () => {
    const markers = buildTradeMarkers([
      trade({
        entry: null,
        exits: [
          { time: 2_000_000, price: 110, quantitySold: 20, quantityRemaining: 30, reason: 'CLOSED' },
        ],
      }),
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('exit');
    // entryQty reconstructed as 20 + 30 = 50.
    expect(markers[0].tooltip).toBe('sold 20 / 50 · 30 remaining · src: Manual');
  });

  it('returns an empty list for no trades', () => {
    expect(buildTradeMarkers([])).toEqual([]);
  });
});
