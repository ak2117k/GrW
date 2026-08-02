import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isChartDisposed,
  isSeriesDisposed,
  markChartDisposed,
  withLiveChart,
  withLiveSeries,
} from './chart-lifecycle';

/**
 * Lightweight Charts throws "Object is disposed" when anything touches a chart
 * after `chart.remove()`. The dangerous case is NOT the synchronous throw — it
 * is that a partially-executed call schedules an internal repaint via
 * requestAnimationFrame, and THAT frame fires later against a null canvas with
 * no app code on the stack to catch it:
 *
 *   Vc(e){ … this.Km = window.requestAnimationFrame(…) }   // queued
 *   get canvasElement(){ if(this._canvasElement===null) throw … }
 *
 * `chart.remove()` cancels the frame pending AT THAT MOMENT, so the only way to
 * leak one is to call in afterwards. try/catch cannot help: the throw happens on
 * a later frame. The fix is therefore to never make the call — gate on a
 * disposal registry instead of catching the fallout.
 */

// Charts are opaque handles here; plain objects stand in for IChartApi.
type FakeChart = { id: string };
const chart = (id = 'c1'): FakeChart => ({ id });

describe('markChartDisposed / isChartDisposed', () => {
  it('reports a fresh chart as live', () => {
    expect(isChartDisposed(chart())).toBe(false);
  });

  it('reports a chart as disposed once marked', () => {
    const c = chart();
    markChartDisposed(c);
    expect(isChartDisposed(c)).toBe(true);
  });

  it('tracks charts independently', () => {
    const a = chart('a');
    const b = chart('b');
    markChartDisposed(a);
    expect(isChartDisposed(a)).toBe(true);
    expect(isChartDisposed(b)).toBe(false);
  });

  it('treats null and undefined as disposed — nothing to call into', () => {
    expect(isChartDisposed(null)).toBe(true);
    expect(isChartDisposed(undefined)).toBe(true);
  });

  it('is idempotent', () => {
    const c = chart();
    markChartDisposed(c);
    markChartDisposed(c);
    expect(isChartDisposed(c)).toBe(true);
  });

  it('ignores a null chart without throwing', () => {
    expect(() => markChartDisposed(null)).not.toThrow();
  });
});

describe('withLiveChart', () => {
  it('runs the callback on a live chart and reports it ran', () => {
    const c = chart();
    const fn = vi.fn();
    expect(withLiveChart(c, fn)).toBe(true);
    expect(fn).toHaveBeenCalledWith(c);
  });

  it('does NOT run the callback once the chart is disposed', () => {
    const c = chart();
    markChartDisposed(c);
    const fn = vi.fn();
    expect(withLiveChart(c, fn)).toBe(false);
    // The whole point: no call means no repaint queued against a dead canvas.
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not run the callback for a null chart', () => {
    const fn = vi.fn();
    expect(withLiveChart(null, fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('swallows a synchronous throw and reports failure', () => {
    // Belt and braces: a chart can be disposed by a path that never marked it.
    const c = chart();
    const fn = vi.fn(() => {
      throw new Error('Object is disposed');
    });
    expect(withLiveChart(c, fn)).toBe(false);
  });

  it('marks the chart disposed after it throws, so later calls are skipped', () => {
    const c = chart();
    withLiveChart(c, () => {
      throw new Error('Object is disposed');
    });
    expect(isChartDisposed(c)).toBe(true);

    const after = vi.fn();
    withLiveChart(c, after);
    expect(after).not.toHaveBeenCalled();
  });
});

describe('withLiveSeries', () => {
  it('runs the callback on a live series', () => {
    const series = { s: 1 };
    const fn = vi.fn();
    expect(withLiveSeries(series, fn)).toBe(true);
    expect(fn).toHaveBeenCalledWith(series);
  });

  it('skips a series disposed with its owning chart', () => {
    // Overlays like LevelOverlay/SetupMarker hold ONLY a series — the owner
    // marks both together so they still have something to gate on.
    const c = chart();
    const series = { s: 1 };
    markChartDisposed(c, [series]);
    const fn = vi.fn();
    expect(withLiveSeries(series, fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips when the series is null', () => {
    const fn = vi.fn();
    expect(withLiveSeries(null, fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves an unrelated series alone when a chart is disposed', () => {
    const owned = { s: 'owned' };
    const other = { s: 'other' };
    markChartDisposed(chart(), [owned]);
    expect(isSeriesDisposed(owned)).toBe(true);
    expect(isSeriesDisposed(other)).toBe(false);
  });

  it('marks the series disposed after it throws, so later calls skip', () => {
    const series = { s: 1 };
    withLiveSeries(series, () => {
      throw new Error('Object is disposed');
    });
    const after = vi.fn();
    expect(withLiveSeries(series, after)).toBe(false);
    expect(after).not.toHaveBeenCalled();
  });

  it('tolerates a chart disposed with no series listed', () => {
    expect(() => markChartDisposed(chart())).not.toThrow();
  });
});

describe('disposal registry does not leak across charts', () => {
  let a: FakeChart;
  beforeEach(() => {
    a = chart('fresh');
  });

  it('a brand new object is never pre-marked', () => {
    expect(isChartDisposed(a)).toBe(false);
  });
});
