import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { CandlestickChart, ChartToolbar, IndicatorPanel, OIOverlay, DrawingToolbar, DrawingsOverlay, PatternOverlay, TradeMarkerOverlay } from '@/components/charts';
import type { CandlestickChartHandle } from '@/components/charts';
import LevelOverlay, { LEVEL_COLORS } from '@/components/charts/LevelOverlay';
import SetupMarker from '@/components/charts/SetupMarker';
import EntryTargetOverlay from '@/components/charts/EntryTargetOverlay';
import ChartZoneOverlay from '@/components/charts/ChartZoneOverlay';
import { buildSRView } from '@/components/charts/buildSRView';
import EvidenceLevelOverlay from '@/components/charts/EvidenceLevelOverlay';
import TrendLineOverlay from '@/components/charts/TrendLineOverlay';
import { useChartContext } from '@/hooks/useChartContext';
import { usePatterns } from '@/hooks/usePatterns';
import StockOverviewPanel from '@/components/stock-overview/StockOverviewPanel';
import { useChartData } from '@/hooks/useChartData';
import { useDrawingPersistence } from '@/hooks/useDrawingPersistence';
import { useChartStore, type SelectedSymbol } from '@/stores/chart-store';
import { useMarketStore } from '@/stores/market-store';
import api from '@/services/api';
import type { EvidenceLevel, SetupContext, StrongZone } from '@/types';
import { CHART_TIMEFRAMES } from '@td/shared';
import { deriveBadge, type BadgeTone } from './feedState';
import { deriveSrChip } from './srChip';

/** Tailwind classes per badge tone — kept beside the page that renders it. */
const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  green:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 [&>span:first-child]:bg-emerald-400',
  amber:
    'border-amber-500/30 bg-amber-500/10 text-amber-400 [&>span:first-child]:bg-amber-400',
  red: 'border-red-500/30 bg-red-500/10 text-red-400 [&>span:first-child]:bg-red-400',
  muted:
    'border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/90 text-[var(--color-text-muted)] [&>span:first-child]:bg-[var(--color-text-muted)]',
};

const WATCHLIST_ITEMS: SelectedSymbol[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', name: 'NIFTY 50' },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', name: 'BANK NIFTY' },
  { symbol: 'FINNIFTY', token: '99926037', exchange: 'NSE', name: 'FIN NIFTY' },
  { symbol: 'SENSEX', token: '99919000', exchange: 'BSE', name: 'SENSEX' },
  { symbol: 'NIFTY MIDCAP 50', token: '99926025', exchange: 'NSE', name: 'NIFTY MIDCAP' },
  { symbol: 'NIFTY IT', token: '99926013', exchange: 'NSE', name: 'NIFTY IT' },
  { symbol: 'GOLD', token: '459277', exchange: 'MCX', name: 'GOLD' },
  { symbol: 'SILVER', token: '464150', exchange: 'MCX', name: 'SILVER' },
  { symbol: 'NATURALGAS', token: '538685', exchange: 'MCX', name: 'NATURAL GAS' },
];


/** Toolbar roster, as a membership test for the S/R gate. */
const SR_OFFERED_TIMEFRAMES = new Set<string>(CHART_TIMEFRAMES);

// Stable empty fallbacks — a fresh `[]` per render would re-run every memo
// that depends on the zone/evidence arrays on every tick.
const EMPTY_ZONES: StrongZone[] = [];
const EMPTY_EVIDENCE: EvidenceLevel[] = [];

/**
 * A level book that hasn't warmed yet reports 0 for PDH/PDL/VWAP (and the
 * lazy VWAP build leaves 0 outside market hours). Drawing those puts a
 * horizontal line and an axis label at price 0, which on an index chart
 * collapses the price scale and reads as a real support level.
 */
function isPlottableLevel(l: { value: number | null | undefined }): boolean {
  return typeof l.value === 'number' && Number.isFinite(l.value) && l.value > 0;
}

export default function ChartsPage() {
  const chartRef = useRef<CandlestickChartHandle>(null);
  const [showIndicators, setShowIndicators] = useState(false);
  // Pattern overlays default OFF — opt-in so a chart never boots cluttered.
  const [showPatterns, setShowPatterns] = useState(false);
  // Only the hovered bar's TIME is stored — the bar itself is looked up from
  // `candles` at render. Storing a snapshot of the OHLC froze the readout at
  // whatever the bar looked like when the pointer landed, so the header and
  // the bar under the crosshair drifted apart as live ticks came in.
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null);
  // Mobile watchlist drawer: the sidebar can't sit beside the chart on a phone,
  // so on <md it becomes an off-canvas drawer toggled from a chart button.
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const setSymbol = useChartStore((s) => s.setSymbol);
  const indicators = useChartStore((s) => s.indicators);
  const isFullscreen = useChartStore((s) => s.isFullscreen);
  const timeframe = useChartStore((s) => s.timeframe);
  const setTimeframe = useChartStore((s) => s.setTimeframe);

  // Live always-on chart analysis — either a setup payload
  // (entry/SL/target/grade) or a no-setup result carrying the current
  // PDH/PDL/VWAP context. Distinct from signal-mode (?signal=<id>): analysis
  // runs continuously on whatever the user is looking at, signal-mode only
  // fires when navigated from a SignalCard's "View Chart" link.
  //
  // Sourced from ONE composite poll (/signals/chart-context, 60s) that also
  // carries zones + evidence, NOT a second poll of /analyze. The composite
  // already runs analyze() to build this; polling it separately meant the
  // drawn level lines and the S/R readout came from two requests on two
  // cadences over one computation, free to disagree in the window between
  // them. Per-source status also means partial arrival can no longer read as
  // "no levels" — the DTO says which it is.
  const { context: chartContext } = useChartContext(
    selectedSymbol.token,
    selectedSymbol.exchange,
    timeframe,
  );
  const zones = chartContext?.zones ?? EMPTY_ZONES;
  const evidence = chartContext?.evidence ?? EMPTY_EVIDENCE;
  const analysis = chartContext?.analysis ?? null;
  // No response yet for the current symbol/timeframe.
  const analysisLoading = chartContext === null;

  // ─── URL ↔ chart-store sync (refresh-safe) ──────────────────────────
  //
  // The chart's selected symbol and timeframe live in two places:
  //   1. zustand store  (in-memory, lost on refresh)
  //   2. URL query string  (durable across refreshes, shareable)
  //
  // We keep them in sync bidirectionally:
  //   - URL → store: when the user lands with `?symbol=…&token=…&tf=…`
  //     (refresh, deeplink, click from Market page), hydrate the store.
  //   - store → URL: when the user picks a different symbol from search
  //     or a different timeframe from the toolbar, push it into the URL
  //     with `replace: true` so the browser back button doesn't pile up
  //     a history entry per click.
  //
  // The two effects don't loop because each guards on equality —
  // re-applying values that already match is a no-op.

  // URL → store
  useEffect(() => {
    const symbol = searchParams.get('symbol');
    const token = searchParams.get('token');
    const exchange = searchParams.get('exchange') ?? 'NSE';
    const tf = searchParams.get('tf');

    if (
      symbol &&
      token &&
      (symbol !== selectedSymbol.symbol ||
        token !== selectedSymbol.token ||
        exchange !== selectedSymbol.exchange)
    ) {
      setSymbol({
        symbol,
        token,
        exchange,
        name: searchParams.get('name') ?? symbol,
      });
    }
    if (tf && tf !== timeframe) {
      setTimeframe(tf);
    }
    // Reads selectedSymbol/timeframe via closure for the equality guard,
    // but only re-runs on URL changes — including them as deps would
    // create a circular trigger with the store→URL effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSymbol, setTimeframe]);

  // store → URL
  useEffect(() => {
    if (!selectedSymbol.token) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('symbol', selectedSymbol.symbol);
        next.set('token', selectedSymbol.token);
        next.set('exchange', selectedSymbol.exchange);
        next.set('tf', timeframe);
        if (
          selectedSymbol.name &&
          selectedSymbol.name !== selectedSymbol.symbol
        ) {
          next.set('name', selectedSymbol.name);
        } else {
          next.delete('name');
        }
        return next;
      },
      { replace: true },
    );
  }, [
    selectedSymbol.symbol,
    selectedSymbol.token,
    selectedSymbol.exchange,
    selectedSymbol.name,
    timeframe,
    setSearchParams,
  ]);

  // Signal mode: fetch setupContext when ?signal=<id> is in the URL
  const signalId = searchParams.get('signal');
  const [setupContext, setSetupContext] = useState<SetupContext | null>(null);

  useEffect(() => {
    if (!signalId) { setSetupContext(null); return; }
    api.get(`/signals/${signalId}`)
      .then((r) => setSetupContext(r.data?.setupContext ?? null))
      .catch(() => setSetupContext(null));
  }, [signalId]);

  const overlayLevels = useMemo(() => {
    if (!setupContext) return [];
    const lb = setupContext.levelBookSnapshot;
    return [
      { type: 'PDH', value: lb.pdh, color: LEVEL_COLORS.PDH, label: 'PDH' },
      { type: 'PDL', value: lb.pdl, color: LEVEL_COLORS.PDL, label: 'PDL' },
      ...(lb.orh !== null ? [{ type: 'ORH', value: lb.orh, color: LEVEL_COLORS.ORH, label: 'ORH' }] : []),
      ...(lb.orl !== null ? [{ type: 'ORL', value: lb.orl, color: LEVEL_COLORS.ORL, label: 'ORL' }] : []),
      { type: 'VWAP', value: lb.vwap, color: LEVEL_COLORS.VWAP, label: 'VWAP' },
    ].filter(isPlottableLevel);
  }, [setupContext]);

  // Always-on level lines derived from the live analysis. Drawn whenever
  // we're not in signal-mode and the analyze endpoint returned a level
  // book — works for both setup and no-setup states. VWAP is omitted
  // when 0 since the lazy-build path leaves it at 0 outside market hours.
  //
  // ORH/ORL fallback: when today's OR hasn't locked yet (null), fall back
  // to the previous session's OR via `prevOrh`/`prevOrl` and render those
  // as dimmed `Y-ORH`/`Y-ORL` lines. The `else` (not addition) means the
  // prior-session lines disappear the moment today's OR locks — no
  // visual duplication.
  const analysisOverlayLevels = useMemo(() => {
    if (setupContext || !analysis?.levels) return [];
    const lb = analysis.levels;
    const orhLine = lb.orh !== null
      ? { type: 'ORH', value: lb.orh, color: LEVEL_COLORS.ORH, label: 'ORH' }
      : lb.prevOrh != null
        ? { type: 'Y_ORH', value: lb.prevOrh, color: LEVEL_COLORS.Y_ORH, label: 'Y-ORH' }
        : null;
    const orlLine = lb.orl !== null
      ? { type: 'ORL', value: lb.orl, color: LEVEL_COLORS.ORL, label: 'ORL' }
      : lb.prevOrl != null
        ? { type: 'Y_ORL', value: lb.prevOrl, color: LEVEL_COLORS.Y_ORL, label: 'Y-ORL' }
        : null;
    return [
      { type: 'PDH', value: lb.pdh, color: LEVEL_COLORS.PDH, label: 'PDH' },
      { type: 'PDL', value: lb.pdl, color: LEVEL_COLORS.PDL, label: 'PDL' },
      ...(orhLine ? [orhLine] : []),
      ...(orlLine ? [orlLine] : []),
      { type: 'VWAP', value: lb.vwap, color: LEVEL_COLORS.VWAP, label: 'VWAP' },
    ].filter(isPlottableLevel);
  }, [analysis, setupContext]);

  const {
    candles,
    oiData,
    isLoading,
    error,
    currentPrice,
    priceChange,
    priceChangePercent,
    realTimeMap,
    loadOlder,
    isLoadingMore,
    hasMoreHistory,
    prependSeq,
    feedState,
  } = useChartData();

  // Connection-state badge inputs.
  //  · marketOpen  — from the app-wide market-store status (populated by
  //    useMarketData() mounted in AppLayout; 'open' covers NSE/MCX hours).
  //  · brokerConnected — no lightweight global broker-connection signal exists
  //    (only heavy page hooks that also fetch balances/positions), so default
  //    to true: authenticated users reaching charts have a connected account,
  //    and the feedState 'error' branch already surfaces a real feed outage.
  const marketOpen = useMarketStore((s) => s.marketStatus === 'open');
  const badge = deriveBadge({ feedState, marketOpen, brokerConnected: true });

  useDrawingPersistence(selectedSymbol.token);

  // S/R renders on every timeframe the toolbar can select — the engine
  // supports all of them (that is the roster invariant), so anything reachable
  // here is analysable. Previously an intraday-only set silently blanked 1d/1w.
  const showSR = SR_OFFERED_TIMEFRAMES.has(timeframe);


  // Chart-pattern overlays (candlestick + chart patterns). Only fetches while
  // the toggle is ON.
  const { patterns } = usePatterns(
    selectedSymbol.token,
    timeframe,
    selectedSymbol.exchange,
    showPatterns,
  );

  // Last candle close — memoised separately so it only recomputes when a new
  // candle actually arrives (not on every live tick that re-creates the
  // `candles` array reference).
  const candleClose = useMemo(
    () => (candles.length > 0 ? candles[candles.length - 1].close : 0),
    [candles],
  );

  // Live price for nearest-wall computation; fall back to last candle close
  // (currentPrice is null pre-feed / outside market hours).
  const ltp = useMemo(
    () => (currentPrice && currentPrice > 0 ? currentPrice : candleClose),
    [currentPrice, candleClose],
  );

  // Unified S/R decision read — nearest wall above + below, synthesized from
  // BOTH the anchored level book (PDH/PDL/ORH/ORL/VWAP) and the pivot zones.
  // Anchored levels are always present, so a moving stock always gets a read.
  const srView = useMemo(
    () => buildSRView(analysis?.levels ?? null, zones, evidence, ltp),
    [analysis?.levels, zones, evidence, ltp],
  );

  // Chip text is a pure decision over (response state, levels) — extracted so
  // the "never claim no levels while loading" rule is unit-testable.
  const srChip = useMemo(
    () =>
      deriveSrChip({
        context: chartContext,
        ltp,
        immediateResistance: srView.immediateResistance,
        immediateSupport: srView.immediateSupport,
      }),
    [chartContext, ltp, srView.immediateResistance, srView.immediateSupport],
  );

  const handleCrosshairMove = useCallback((params: unknown) => {
    const p = params as { time?: number; seriesData?: Map<unknown, unknown> };
    const over = typeof p.time === 'number' && !!p.seriesData && p.seriesData.size > 0;
    setCrosshairTime(over ? (p.time as number) : null);
  }, []);

  // Hovered bar, resolved fresh from the current series so it tracks live
  // updates; falls back to the forming bar when the pointer is off the chart.
  const hoveredBar = useMemo(
    () => (crosshairTime === null ? null : candles.find((c) => c.time === crosshairTime) ?? null),
    [crosshairTime, candles],
  );
  const ohlcData = hoveredBar ?? (candles.length > 0 ? candles[candles.length - 1] : null);
  const ohlcUp = ohlcData ? ohlcData.close >= ohlcData.open : true;

  return (
    <div
      className={clsx(
        'flex flex-col',
        isFullscreen
          ? 'fixed inset-0 z-50 bg-[var(--color-bg-primary)]'
          : 'min-h-[calc(100vh-64px)] overflow-y-auto',
      )}
    >
      {/* Toolbar */}
      <ChartToolbar
        currentPrice={currentPrice}
        priceChange={priceChange}
        priceChangePercent={priceChangePercent}
        onToggleIndicators={() => setShowIndicators(!showIndicators)}
        showIndicatorPanel={showIndicators}
        onTogglePatterns={() => setShowPatterns((v) => !v)}
        showPatterns={showPatterns}
      />

      {/* OHLCV data bar */}
      {ohlcData && (
        <div className="flex items-center gap-4 px-4 py-1.5 bg-[var(--color-bg-primary)] border-b border-[var(--color-border-subtle)] text-xs">
          <OHLCItem label="O" value={ohlcData.open} up={ohlcUp} />
          <OHLCItem label="H" value={ohlcData.high} up={ohlcUp} />
          <OHLCItem label="L" value={ohlcData.low} up={ohlcUp} />
          <OHLCItem label="C" value={ohlcData.close} up={ohlcUp} />
        </div>
      )}

      {/* Chart area — fixed at 70vh so the StockOverviewPanel below has room
          to scroll into view without squishing the chart. */}
      <div className={clsx('flex min-h-0', isFullscreen ? 'flex-1' : 'h-[70vh]')}>

        {/* Watchlist — static column on md+, off-canvas drawer on mobile */}
        {!isFullscreen && (
          <>
            {/* Mobile backdrop (tap to close) */}
            {watchlistOpen && (
              <div
                className="fixed inset-0 z-30 bg-black/40 md:hidden"
                onClick={() => setWatchlistOpen(false)}
                aria-hidden
              />
            )}
          <div
            className={clsx(
              'border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-y-auto',
              // md+: in-flow fixed-width column (unchanged desktop look)
              'md:static md:z-auto md:w-48 md:shrink-0 md:translate-x-0',
              // <md: off-canvas drawer that slides in when open
              'fixed inset-y-0 left-0 z-40 w-64 transition-transform duration-200',
              watchlistOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
            )}
          >
            <div className="px-3 py-2 border-b border-[var(--color-border-subtle)]">
              <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                Watchlist
              </h3>
            </div>
            {WATCHLIST_ITEMS.map((item) => {
              const isActive = item.token === selectedSymbol.token;
              return (
                <button
                  key={item.token}
                  onClick={() => {
                    setSymbol(item);
                    setWatchlistOpen(false); // close the drawer after picking on mobile
                  }}
                  className={clsx(
                    'w-full px-3 py-2.5 text-left border-b border-[var(--color-border-subtle)] transition-colors',
                    isActive
                      ? 'bg-[var(--color-bg-tertiary)] border-l-2 border-l-[var(--color-accent-blue)]'
                      : 'hover:bg-[var(--color-bg-tertiary)]',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={clsx(
                        'text-xs font-medium',
                        isActive
                          ? 'text-[var(--color-text-primary)]'
                          : 'text-[var(--color-text-secondary)]',
                      )}
                    >
                      {item.symbol}
                    </span>
                    {isActive && (
                      <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-blue)]" />
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                    {item.exchange}
                  </p>
                </button>
              );
            })}
          </div>
          </>
        )}

        {/* Drawing toolbar — left-side vertical, Groww-style. Hidden on mobile so
            the chart gets full width; drawing is a desktop interaction. */}
        <div className="hidden md:block">
          <DrawingToolbar token={selectedSymbol.token} />
        </div>

        {/* Chart area. h-full is required because the inner CandlestickChart
            uses height: '100%' which can't resolve on a flex item without an
            explicit definite height when the row's outer container is
            min-h-* (not a fixed h-*). Without this, the chart collapsed to
            its 300px minHeight or disappeared entirely. */}
        <div className="flex-1 relative min-w-0 h-full">
          {/* Mobile-only watchlist toggle — opens the off-canvas drawer. Hidden
              on md+ where the sidebar is always visible. */}
          {!isFullscreen && (
            <button
              onClick={() => setWatchlistOpen(true)}
              aria-label="Open watchlist"
              className="md:hidden absolute top-2 left-2 z-20 flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/90 px-2 py-1 text-xs text-[var(--color-text-secondary)] shadow backdrop-blur-sm"
            >
              ☰ Watchlist
            </button>
          )}
          {/* Full-area loader during any candle fetch. The chart's `key`
              prop already unmounts the previous symbol's chart on switch,
              so the loader overlays an empty area — no flash of stale
              chart shape underneath. Holds until candles fully load. */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-primary)]/95 backdrop-blur-sm z-10">
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 border-2 border-[var(--color-accent-blue)] border-t-transparent rounded-full animate-spin" />
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    Loading {selectedSymbol.symbol}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {selectedSymbol.exchange} · {timeframe}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Connection-state badge — an honest, always-visible read of the
              per-user live feed (replaces the old ambiguous "demo data" text). */}
          {!isFullscreen && (
            <div
              className={clsx(
                'absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow backdrop-blur-sm',
                BADGE_TONE_CLASSES[badge.tone],
              )}
              title={`Feed: ${feedState}`}
            >
              <span className="h-1.5 w-1.5 rounded-full" aria-hidden />
              {badge.label}
            </div>
          )}

          {error && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-primary)] z-10">
              <div className="text-center">
                <p className="text-sm text-[var(--color-accent-red)]">{error}</p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {badge.label}
                </p>
              </div>
            </div>
          )}

          {/* Groww-style "loading older history" pill — shows while a
              previous-candles fetch is in flight after scrolling to the left edge. */}
          {isLoadingMore && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full bg-[var(--color-bg-secondary)]/90 px-3 py-1 text-xs text-[var(--color-text-secondary)] shadow backdrop-blur-sm">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-accent-blue)] border-t-transparent" />
              Loading older history…
            </div>
          )}

          <CandlestickChart
            key={selectedSymbol.token}
            ref={chartRef}
            candles={candles}
            onCrosshairMove={handleCrosshairMove}
            showVolume={indicators.volume}
            realTimeMap={realTimeMap}
            onLoadOlder={loadOlder}
            canLoadOlder={hasMoreHistory && !isLoadingMore}
            prependSeq={prependSeq}
          />

          {/* User-drawn annotations (hline, hzone, trend, vline, rect, fib, text, arrow) */}
          <DrawingsOverlay
            token={selectedSymbol.token}
            chart={chartRef.current?.chart ?? null}
            series={chartRef.current?.candleSeries ?? null}
            realTimeMap={realTimeMap}
          />

          {/* Pattern overlay — candlestick + chart-pattern markers + necklines.
              Default OFF; opt-in via the toolbar "Patterns" toggle. */}
          {showPatterns && (
            <PatternOverlay
              series={chartRef.current?.candleSeries ?? null}
              chart={chartRef.current?.chart ?? null}
              patterns={patterns}
              realTimeMap={realTimeMap}
            />
          )}

          {/* Realized-trade annotations — entry (▲/▼) + exit (●) markers with
              sold/remaining/source hover. Custom-positioned HTML, so it never
              touches the shared setMarkers() that PatternOverlay owns. */}
          <TradeMarkerOverlay
            token={selectedSymbol.token}
            chart={chartRef.current?.chart ?? null}
            series={chartRef.current?.candleSeries ?? null}
            realTimeMap={realTimeMap}
          />

          {/* OI Overlay (renders onto the chart, no DOM) */}
          <OIOverlay
            chart={chartRef.current?.chart ?? null}
            oiData={oiData}
            visible={indicators.oi}
          />

          {/* Signal-mode overlays: level lines + setup marker */}
          {setupContext && (
            <>
              <LevelOverlay series={chartRef.current?.candleSeries ?? null} levels={overlayLevels} />
              <SetupMarker
                series={chartRef.current?.candleSeries ?? null}
                time={setupContext.triggerCandle.time}
                side={setupContext.entry > setupContext.stoploss ? 'BUY' : 'SELL'}
                text={`${setupContext.setupType} · ${setupContext.grade}`}
              />
            </>
          )}

          {/* Always-on analysis overlays — only when not in signal-mode.
              Levels render in both setup and no-setup states; entry/SL/target
              lines only when there's a setup. */}
          {!setupContext && analysisOverlayLevels.length > 0 && (
            <LevelOverlay
              series={chartRef.current?.candleSeries ?? null}
              levels={analysisOverlayLevels}
            />
          )}
          {/* Strong-zone S/R overlay — immediate (next wall) + major (STRONG
              structural) tiers. Rendered on every native intraday timeframe. */}
          {showSR && ltp > 0 && (
            <ChartZoneOverlay
              candleSeries={chartRef.current?.candleSeries ?? null}
              zones={zones}
              ltp={ltp}
            />
          )}
          {showSR && ltp > 0 && (
            <EvidenceLevelOverlay
              candleSeries={chartRef.current?.candleSeries ?? null}
              evidence={evidence}
            />
          )}
          {/* Fitted trend line. Needs no `ltp` (it is anchored on pivots, not
              on distance from price) and draws nothing when the fit was
              rejected — `trend: null` is a valid answer, not a missing one. */}
          {showSR && (
            <TrendLineOverlay
              chart={chartRef.current?.chart ?? null}
              trend={chartContext?.trend ?? null}
              candles={candles}
            />
          )}
          {!setupContext && analysis?.kind === 'setup' && (
            <EntryTargetOverlay
              series={chartRef.current?.candleSeries ?? null}
              entry={analysis.entry}
              stoploss={analysis.stoploss}
              target={analysis.target}
              partialTakeAt={analysis.partialTakeAt ?? null}
              trailingSl={analysis.trailingSl ?? null}
              status={analysis.status}
            />
          )}

          {/* Indicator panel overlay */}
          {showIndicators && (
            <IndicatorPanel
              onClose={() => setShowIndicators(false)}
              chart={chartRef.current?.chart ?? null}
              candles={candles}
            />
          )}

          {/* S/R status chip — distinguishes loading / unavailable / no levels
              so a not-yet-arrived (or failed) fetch is never rendered as a
              definitive statement about the market. */}
          {showSR && (
            <div className="absolute top-3 right-3 z-20 rounded-full bg-[var(--color-bg-secondary)]/90 px-3 py-1 text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)] shadow backdrop-blur-sm">
              {srChip.text}
              {srChip.warning && (
                <span className="ml-1 text-[var(--color-accent-amber,#f59e0b)]" title={srChip.warning}>
                  ⚠
                </span>
              )}
            </div>
          )}

          {/* Watermark */}
          <div className="absolute top-4 left-4 pointer-events-none select-none z-20">
            <span className="text-2xl font-bold text-[var(--color-text-primary)] opacity-10">
              {selectedSymbol.symbol}
            </span>
          </div>
        </div>
      </div>

      {/* Scrollable info panel below the chart. Hidden in fullscreen so the
          chart truly fills the viewport. */}
      {!isFullscreen && (
        <StockOverviewPanel
          token={selectedSymbol.token}
          exchange={selectedSymbol.exchange}
          symbol={selectedSymbol.symbol}
          timeframe={timeframe}
          analysis={analysis}
          analysisLoading={analysisLoading}
        />
      )}
    </div>
  );
}

function OHLCItem({ label, value, up }: { label: string; value: number; up: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span
        className={clsx(
          'font-medium tabular-nums',
          up ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]',
        )}
      >
        {value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
