/**
 * Disposal registry for Lightweight Charts instances.
 *
 * ## The problem
 *
 * `ChartsPage` renders `<CandlestickChart key={selectedSymbol.token}>`, so the
 * chart is DESTROYED AND REBUILT on every symbol change. The overlays
 * (drawings, patterns, trade markers, OI, indicators) are unkeyed siblings that
 * receive `chart={chartRef.current?.chart ?? null}` — a ref read during render.
 * Across a remount they therefore hold, for a window, the chart instance that
 * was just `remove()`d, and their effects/cleanups call into it.
 *
 * Lightweight Charts answers such a call with `Error: Object is disposed`. The
 * synchronous throw is the harmless half. The damaging half is that a call which
 * partially executes before throwing has already queued an internal repaint:
 *
 *   Vc(e){ … this.Km = window.requestAnimationFrame(…) }        // queued
 *   vp(e){ … gl(this.Gv) … }                                    // paints
 *   get canvasElement(){ if(this._canvasElement===null) throw … }
 *
 * `chart.remove()` cancels the frame pending at that moment (`destroy()` calls
 * `cancelAnimationFrame`), so the ONLY way to leak one is to call in after
 * disposal. That frame then fires with no app code on the stack — which is why
 * the `try { … } catch { /* disposed *\/ }` guards scattered through the overlay
 * components cannot stop it. They catch the sync throw; the repaint still lands.
 *
 * ## The approach
 *
 * Don't catch the fallout — don't make the call. `CandlestickChart` marks its
 * chart here immediately BEFORE `remove()`, and every overlay routes its chart
 * access through `withLiveChart` / `withLiveSeries`, which no-op on a disposed
 * instance. A `WeakSet` keys off the chart object itself, so entries vanish with
 * the chart and nothing needs cleaning up.
 *
 * The try/catch inside the helpers is a backstop for charts disposed by a path
 * that never marked them; a throw self-heals by marking the chart, so the next
 * call is skipped rather than re-thrown.
 */

/** Opaque chart/series handle. Structural so tests need no real chart. */
type ChartLike = object;

const disposedCharts = new WeakSet<ChartLike>();
const disposedSeries = new WeakSet<ChartLike>();

/**
 * Record a chart as disposed, along with any series it owned. Call IMMEDIATELY
 * BEFORE `chart.remove()`.
 *
 * Several overlays (`LevelOverlay`, `SetupMarker`, `EntryTargetOverlay`,
 * `EvidenceLevelOverlay`) receive ONLY a series — they have no chart handle to
 * check — so the owner must mark its series here for them to gate on.
 */
export function markChartDisposed(
  chart: ChartLike | null | undefined,
  ownedSeries: readonly (ChartLike | null | undefined)[] = [],
): void {
  if (chart) disposedCharts.add(chart);
  for (const s of ownedSeries) {
    if (s) disposedSeries.add(s);
  }
}

/** True when the series (or its owning chart) is gone and must not be touched. */
export function isSeriesDisposed(series: ChartLike | null | undefined): boolean {
  return !series || disposedSeries.has(series);
}

/** True when the chart is gone (or absent) and must not be touched. */
export function isChartDisposed(chart: ChartLike | null | undefined): boolean {
  return !chart || disposedCharts.has(chart);
}

/**
 * Run `fn` only if `chart` is still alive. Returns whether it ran, so callers
 * can null their own refs when the chart has gone away.
 */
export function withLiveChart<T extends ChartLike>(
  chart: T | null | undefined,
  fn: (chart: T) => void,
): boolean {
  if (isChartDisposed(chart)) return false;
  try {
    fn(chart as T);
    return true;
  } catch {
    // Disposed by a path that didn't mark it — record that now so subsequent
    // calls skip instead of repeating the throw (and re-queuing a repaint).
    markChartDisposed(chart);
    return false;
  }
}

/**
 * Run `fn` on a series only if that series is still alive. Returns whether it
 * ran, so callers can null their own refs.
 *
 * A series holds no back-pointer to its chart, so liveness comes from the
 * registry: `markChartDisposed(chart, [series])` marks both together.
 */
export function withLiveSeries<S extends ChartLike>(
  series: S | null | undefined,
  fn: (series: S) => void,
): boolean {
  if (isSeriesDisposed(series)) return false;
  try {
    fn(series as S);
    return true;
  } catch {
    // Disposed by a path that didn't mark it — record it so later calls skip.
    disposedSeries.add(series as S);
    return false;
  }
}
