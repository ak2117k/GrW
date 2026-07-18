import { describe, it, expect } from 'vitest';
import {
  buildTradeMarkers,
  formatPrice,
  formatSignedPct,
  formatEntryTooltip,
  formatEntryDetail,
  formatPartialTooltip,
  formatExitTooltip,
  exitColor,
  ENTRY_COLOR,
  PARTIAL_COLOR,
  EXIT_PROFIT_COLOR,
  EXIT_LOSS_COLOR,
} from '../tradeMarkers';
import type { PositionMarker } from '@/services/chartTrades.service';

function position(over: Partial<PositionMarker>): PositionMarker {
  return {
    id: 'p1',
    track: 'SWING',
    provenance: 'Manual',
    status: 'TRADED',
    targetPct: 10,
    stopPct: -5,
    entry: { time: 1_000_000, price: 100 },
    partial: null,
    exit: null,
    ...over,
  };
}

describe('formatSignedPct', () => {
  it('always carries a sign to 1 dp', () => {
    expect(formatSignedPct(-10)).toBe('-10.0%');
    expect(formatSignedPct(5.25)).toBe('+5.3%');
    expect(formatSignedPct(0)).toBe('+0.0%');
  });
});

describe('exitColor', () => {
  it('is green at/above break-even and red below', () => {
    expect(exitColor(0)).toBe(EXIT_PROFIT_COLOR);
    expect(exitColor(12.3)).toBe(EXIT_PROFIT_COLOR);
    expect(exitColor(-0.1)).toBe(EXIT_LOSS_COLOR);
  });
});

describe('tooltip formatters', () => {
  it('entry names the price and provenance', () => {
    expect(formatEntryTooltip(100, 'Chartink (breakout)')).toBe(
      `Entered ${formatPrice(100)} · from Chartink (breakout)`,
    );
  });

  it('entry detail shows signed target/stop %', () => {
    expect(formatEntryDetail(10, -5)).toBe('Target +10.0% · Stop -5.0%');
  });

  it('partial formats fraction 0.5 as 50%', () => {
    expect(formatPartialTooltip(0.5, 105)).toBe(`Booked 50% at ${formatPrice(105)}`);
    expect(formatPartialTooltip(0.333, 105)).toBe(`Booked 33% at ${formatPrice(105)}`);
  });

  it('exit shows price, status and signed pnl', () => {
    expect(formatExitTooltip(90, 'STOPPED', -10)).toBe(
      `Exited ${formatPrice(90)} · STOPPED · -10.0%`,
    );
  });
});

describe('buildTradeMarkers', () => {
  it('emits an entry-only marker for an open position and carries provenance', () => {
    const markers = buildTradeMarkers([
      position({ provenance: 'Chartink (gated)', status: 'TRADED', exit: null }),
    ]);

    expect(markers).toHaveLength(1);
    const entry = markers[0];
    expect(entry.kind).toBe('entry');
    expect(entry.glyph).toBe('▲');
    expect(entry.color).toBe(ENTRY_COLOR);
    expect(entry.timeMs).toBe(1_000_000);
    expect(entry.price).toBe(100);
    expect(entry.tooltip).toBe(`Entered ${formatPrice(100)} · from Chartink (gated)`);
    expect(entry.detail).toBe('Target +10.0% · Stop -5.0%');
    expect(entry.key).toBe('p1:entry');
  });

  it('emits entry + exit for a closed position with the pnl sign and loss colour', () => {
    const markers = buildTradeMarkers([
      position({
        status: 'STOPPED',
        exit: { time: 3_000_000, price: 90, status: 'STOPPED', pnlPct: -10, reason: 'SL hit' },
      }),
    ]);

    expect(markers).toHaveLength(2);
    const [, exit] = markers;
    expect(exit.kind).toBe('exit');
    expect(exit.glyph).toBe('●');
    expect(exit.color).toBe(EXIT_LOSS_COLOR);
    expect(exit.timeMs).toBe(3_000_000);
    expect(exit.price).toBe(90);
    expect(exit.tooltip).toBe(`Exited ${formatPrice(90)} · STOPPED · -10.0%`);
    expect(exit.detail).toBe('SL hit');
    expect(exit.key).toBe('p1:exit');
  });

  it('colours a profitable exit green', () => {
    const markers = buildTradeMarkers([
      position({
        status: 'TARGET_HIT',
        exit: { time: 3_000_000, price: 120, status: 'TARGET_HIT', pnlPct: 20, reason: null },
      }),
    ]);
    const exit = markers[1];
    expect(exit.color).toBe(EXIT_PROFIT_COLOR);
    expect(exit.tooltip).toBe(`Exited ${formatPrice(120)} · TARGET_HIT · +20.0%`);
    // A null reason leaves no hover detail.
    expect(exit.detail).toBeUndefined();
  });

  it('emits an intraday partial (◐) between entry and exit, formatting the fraction as %', () => {
    const markers = buildTradeMarkers([
      position({
        track: 'INTRADAY',
        partial: { time: 2_000_000, price: 105, fraction: 0.5 },
        exit: { time: 3_000_000, price: 110, status: 'TARGET_HIT', pnlPct: 10, reason: null },
      }),
    ]);

    expect(markers.map((m) => m.kind)).toEqual(['entry', 'partial', 'exit']);
    const partial = markers[1];
    expect(partial.glyph).toBe('◐');
    expect(partial.color).toBe(PARTIAL_COLOR);
    expect(partial.timeMs).toBe(2_000_000);
    expect(partial.tooltip).toBe(`Booked 50% at ${formatPrice(105)}`);
    expect(partial.key).toBe('p1:partial');
  });

  it('skips a not-yet-entered breakout (entry null)', () => {
    const markers = buildTradeMarkers([
      position({ track: 'BREAKOUT', status: 'QUEUED', entry: null }),
    ]);
    expect(markers).toEqual([]);
  });

  it('returns an empty list for no positions', () => {
    expect(buildTradeMarkers([])).toEqual([]);
  });
});
