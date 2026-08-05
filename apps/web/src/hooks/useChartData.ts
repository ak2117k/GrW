import { useReducer, useMemo, useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { useChartStore } from '@/stores/chart-store';
import {
  emptySeries,
  buildSeries,
  applyTick,
  applyRealBars,
  prependBars,
  findRealGaps,
  toRealTimeMap,
  type ChartSeries,
  type RealBar,
  type SeriesBar,
  type LiveTick,
} from '@/utils/chartSeries';
import type { Candle, OIData } from '@/types';

/**
 * Per-user broker-feed lifecycle state, mirrored from the backend
 * `FeedState` (apps/api/.../user-feed.types.ts). The server emits one of
 * these over the `'feed-state'` socket event scoped to the user's room.
 */
export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

/**
 * The per-user tick payload emitted on the `'tick'` socket event. Mirrors
 * the backend `TickData` (apps/api/.../broker-adapter.interface.ts) — prices
 * are in RUPEES and `timestamp` arrives as an ISO string over socket.io (it
 * is a `Date` on the server). This is NOT a `Quote`: there is no
 * `change`/`changePercent`/`exchange`/`vwap`; the day-change baseline comes
 * from the separate `/quote` REST call in this hook.
 *
 * `volume` is the broker's `volume_trade_for_the_day` — CUMULATIVE, not
 * per-tick. `applyTick` turns it into per-bar volume via the bar's anchor.
 */
interface TickData {
  token: string;
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  timestamp: string;
}

/**
 * Pure diff of the chart's single-token subscription across a symbol switch.
 * Returns the tokens to `subscribe` (add) and `unsubscribe` (remove) so the
 * hook can drive the per-user server feed with exactly one add + one remove.
 * A null token means "nothing subscribed" (empty/`'0'` guarded by the caller).
 */
export function computeSubscriptionDelta(
  prev: string | null,
  next: string | null,
): { add: string[]; remove: string[] } {
  if (prev === next) return { add: [], remove: [] };
  return {
    add: next ? [next] : [],
    remove: prev ? [prev] : [],
  };
}

interface ChartOIData {
  time: number;
  value: number;
}

interface UseChartDataReturn {
  candles: SeriesBar[];
  oiData: ChartOIData[];
  isLoading: boolean;
  error: string | null;
  currentPrice: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  // Maps compressed candle times (what's actually plotted) back to the real
  // unix timestamps, for axis labels and crosshair tooltips. DERIVED from the
  // bars — every plotted bar is in it by construction, so a lookup can never
  // miss and fall back to rendering a compressed time as if it were real.
  realTimeMap: Map<number, number>;
  // Infinite history: fetch + prepend the previous chunk of older candles.
  loadOlder: () => void;
  // True while a loadOlder fetch is in flight (parent gates re-triggers on it).
  isLoadingMore: boolean;
  // False once a loadOlder pull returns nothing older — stop trying.
  hasMoreHistory: boolean;
  // Bumps on each successful prepend so the chart preserves scroll position
  // instead of default-zooming (distinguishes a prepend from a symbol reset).
  prependSeq: number;
  // Latest per-user broker-feed lifecycle, from the 'feed-state' socket event.
  feedState: FeedState;
}

function getTimeframeDurationMs(timeframe: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
    '1w': 7 * 24 * 60 * 60_000,
  };
  return map[timeframe] ?? 15 * 60_000;
}

export function getHistoryRangeDays(timeframe: string): number {
  // Calendar-day lookback for the INITIAL fetch (cold first paint).
  //
  // PERF: sub-hour intervals are fetched per-CALENDAR-DAY by the Angel
  // adapter (each day = one ~350ms-paced REST chunk), so a 15-day 15m
  // window costs ~15 serial calls (~8-12s cold). We only need enough bars
  // to fill the default view (~100 bars, which renders the most-recent
  // slice). The lazy `loadOlder` path fetches older history on scroll, so
  // shrinking the initial window defers — not loses — history while cutting
  // cold-load chunk count dramatically.
  //
  // ~bars-per-trading-day (NSE 6.25h session): 1m≈375, 5m≈75, 15m≈25.
  const map: Record<string, number> = {
    '1m': 1,
    '5m': 3,
    '15m': 5,
    '30m': 30, // hour+ intervals fetch in one wide chunk — no per-day penalty
    '1h': 60,
    '4h': 120,
    '1d': 365,
    '1w': 730,
  };
  return map[timeframe] ?? 3;
}

/** API candle payload -> the broker-bar shape the series model consumes. */
function toRealBars(raw: Candle[]): RealBar[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    time: new Date(c.timestamp).getTime() / 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * Report, in the devtools console, exactly which market times are missing from
 * a freshly-loaded series.
 *
 * A hole that straddles an overnight/weekend boundary is EXPECTED. A hole
 * WITHIN one trading session means the broker never gave us those bars — the
 * usual cause being a throttled history chunk. This is the difference between
 * "the chart looks wrong" and a precise, reportable fact, so it stays in the
 * production bundle deliberately.
 */
function logGapDiagnostic(
  symbol: string,
  timeframe: string,
  bars: RealBar[],
  tfSec: number,
  source?: string,
): void {
  const gaps = findRealGaps(buildSeries(bars, tfSec));
  const fmt = (sec: number) =>
    new Date(sec * 1000).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    });
  // eslint-disable-next-line no-console
  console.log(
    `[chart] ${symbol} ${timeframe}: ${bars.length} bars` +
      (source ? ` (source=${source})` : '') +
      ` | ${gaps.length} gap(s)`,
    gaps.map((g) => `${fmt(g.fromReal)} → ${fmt(g.toReal)} (~${g.missingBars} bars missing)`),
  );
}

// ---------------------------------------------------------------------------
// Series state: ONE reducer owns the bars.
//
// Every writer (initial fetch, WS tick, 20s REST poll, reconnect gap-fill,
// infinite-history prepend) goes through this reducer, and every action
// carries the `epoch` it was issued under. A response that arrives after the
// user switched symbol or timeframe has a stale epoch and is dropped — which
// is what stops an in-flight 15m poll from merging its bars into a 1H series,
// or the previous symbol's bars from landing on the new symbol's chart.
//
// The reducer is PURE: no refs mutated, no sibling setState called from inside
// it. That is the property the previous implementation lacked, and the reason
// a bar and its real-time label could commit independently.
// ---------------------------------------------------------------------------

export interface SeriesState {
  epoch: number;
  series: ChartSeries;
  prependSeq: number;
}

export type SeriesAction =
  | { type: 'reset'; epoch: number; tfSec: number }
  | { type: 'load'; epoch: number; bars: RealBar[] }
  | { type: 'tick'; epoch: number; tick: LiveTick }
  | { type: 'rest'; epoch: number; bars: RealBar[] }
  | { type: 'prepend'; epoch: number; bars: RealBar[] };

export function seriesReducer(state: SeriesState, action: SeriesAction): SeriesState {
  if (action.type === 'reset') {
    // prependSeq is deliberately NOT reset: the chart reads a bump as
    // "preserve scroll", and a symbol switch must read as a full reset.
    return { epoch: action.epoch, series: emptySeries(action.tfSec), prependSeq: state.prependSeq };
  }
  if (action.epoch !== state.epoch) return state; // stale async response

  switch (action.type) {
    case 'load': {
      const series = buildSeries(action.bars, state.series.tfSec);
      return { ...state, series };
    }
    case 'tick': {
      const series = applyTick(state.series, action.tick);
      return series === state.series ? state : { ...state, series };
    }
    case 'rest': {
      const series = applyRealBars(state.series, action.bars);
      return series === state.series ? state : { ...state, series };
    }
    case 'prepend': {
      const { series, prepended } = prependBars(state.series, action.bars);
      if (prepended === 0) return state;
      return { ...state, series, prependSeq: state.prependSeq + 1 };
    }
    default:
      return state;
  }
}

export function useChartData(): UseChartDataReturn {
  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const timeframe = useChartStore((s) => s.timeframe);

  const [state, dispatch] = useReducer(seriesReducer, undefined, () => ({
    epoch: 0,
    series: emptySeries(getTimeframeDurationMs('15m') / 1000),
    prependSeq: 0,
  }));
  const { series, prependSeq } = state;

  const [oiData, setOiData] = useState<ChartOIData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceChangePercent, setPriceChangePercent] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [feedState, setFeedState] = useState<FeedState>('connecting');

  // Monotonic epoch, bumped synchronously wherever a reset is dispatched, so
  // an async caller can stamp the epoch it started under without waiting for
  // a render. The reducer is the only thing that reads it back for comparison.
  const epochRef = useRef(0);
  // Previous feed-state, so a reconnecting -> live transition gap-fills once.
  const prevFeedStateRef = useRef<FeedState | null>(null);
  // The token currently subscribed on the per-user server feed.
  const subscribedTokenRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);

  const realTimeMap = useMemo(() => toRealTimeMap(series), [series]);

  // -------------------------------------------------------------------------
  // Initial fetch. Bumps the epoch first, which both clears the chart and
  // invalidates every in-flight response from the previous symbol/timeframe.
  // -------------------------------------------------------------------------
  const fetchCandles = useCallback(async () => {
    const tfSec = getTimeframeDurationMs(timeframe) / 1000;
    const epoch = ++epochRef.current;
    dispatch({ type: 'reset', epoch, tfSec });
    loadingMoreRef.current = false;
    hasMoreRef.current = true;
    setHasMoreHistory(true);
    setIsLoadingMore(false);
    setIsLoading(true);
    setError(null);

    try {
      const days = getHistoryRangeDays(timeframe);
      const to = new Date().toISOString();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        { params: { timeframe, from, to, exchange: selectedSymbol.exchange } },
      );
      if (epoch !== epochRef.current) return; // superseded

      const bars = toRealBars(response.data?.candles ?? response.data?.data ?? []);
      dispatch({ type: 'load', epoch, bars });
      logGapDiagnostic(selectedSymbol.symbol, timeframe, bars, tfSec, response.data?.source);

      if (bars.length > 0) {
        setCurrentPrice(bars[bars.length - 1].close);
        // The daily-change baseline is the PREVIOUS TRADING DAY's close, which
        // only /quote knows. Deriving it from the first candle in a multi-day
        // window compares today to a week ago.
        try {
          const quoteResp = await api.get(
            `/market-data/instruments/${selectedSymbol.token}/quote`,
            { params: { exchange: selectedSymbol.exchange } },
          );
          if (epoch !== epochRef.current) return;
          const q = quoteResp.data?.quote;
          if (q && typeof q.change === 'number' && typeof q.changePercent === 'number') {
            setPriceChange(q.change);
            setPriceChangePercent(q.changePercent);
            if (typeof q.ltp === 'number' && q.ltp > 0) setCurrentPrice(q.ltp);
          }
        } catch {
          // Leave price/change unset rather than show a wrong baseline; the
          // WS tick will populate them once live ticks resume.
        }
      }
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch candles');
    } finally {
      if (epoch === epochRef.current) setIsLoading(false);
    }
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe]);

  const fetchOI = useCallback(async () => {
    try {
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/oi`,
      );
      const payload = response.data;
      const candidate =
        (payload?.oi as OIData[] | undefined) ??
        (payload?.data as OIData[] | undefined) ??
        payload;
      const rawOI: OIData[] = Array.isArray(candidate) ? candidate : [];
      if (!Array.isArray(candidate) && payload != null) {
        console.warn('useChartData: unexpected OI response shape');
      }
      setOiData(
        rawOI.map((o) => ({
          time: new Date(o.timestamp).getTime() / 1000,
          value: o.oi,
        })),
      );
    } catch {
      // OI data is optional, fail silently — no chart blocker.
    }
  }, [selectedSymbol.token]);

  useEffect(() => {
    fetchCandles();
    fetchOI();
  }, [fetchCandles, fetchOI]);

  // -------------------------------------------------------------------------
  // Infinite history
  // -------------------------------------------------------------------------
  const oldestReal = series.bars.length > 0 ? series.bars[0].realTime : null;

  const loadOlder = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    if (oldestReal == null) return;

    const epoch = epochRef.current;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const days = getHistoryRangeDays(timeframe);
      const toMs = (oldestReal - 1) * 1000; // just before our current oldest bar
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        {
          params: {
            timeframe,
            from: new Date(toMs - days * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date(toMs).toISOString(),
            exchange: selectedSymbol.exchange,
          },
        },
      );
      if (epoch !== epochRef.current) return;

      const older = toRealBars(response.data?.candles ?? response.data?.data ?? []).filter(
        (b) => b.time < oldestReal,
      );
      if (older.length === 0) {
        hasMoreRef.current = false;
        setHasMoreHistory(false);
        return;
      }
      dispatch({ type: 'prepend', epoch, bars: older });
    } catch {
      // Soft failure — leave hasMore true so a later pan can retry.
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [timeframe, selectedSymbol.token, selectedSymbol.exchange, oldestReal]);

  // -------------------------------------------------------------------------
  // Live-edge REST refresh. The completed-candle series must advance with the
  // market even when the WS tick feed doesn't reach the browser (Cloudflare
  // polling-transport stalls), otherwise the chart freezes at load-time's last
  // bar while the LTP keeps moving. It is ALSO the authority for the first bar
  // of a session, which `applyTick` deliberately refuses to invent.
  // -------------------------------------------------------------------------
  const liveEdgeRefresh = useCallback(async () => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    // Enough lookback to always include the current session tail.
    const WINDOW_MS = 8 * 60 * 60 * 1000;
    const epoch = epochRef.current;
    try {
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        {
          params: {
            timeframe,
            from: new Date(Date.now() - WINDOW_MS).toISOString(),
            to: new Date().toISOString(),
            exchange: selectedSymbol.exchange,
          },
        },
      );
      if (epoch !== epochRef.current) return;
      dispatch({
        type: 'rest',
        epoch,
        bars: toRealBars(response.data?.candles ?? response.data?.data ?? []),
      });
    } catch {
      // Soft failure — the next tick or poll will catch up.
    }
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe]);

  useEffect(() => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    const id = setInterval(liveEdgeRefresh, 20_000);
    return () => clearInterval(id);
  }, [selectedSymbol.token, liveEdgeRefresh]);

  // -------------------------------------------------------------------------
  // Feed plumbing
  // -------------------------------------------------------------------------

  // Ensure the symbol is subscribed to the live tick feed. The backend boots
  // with a hardcoded universe (~30 tokens), so anything outside it has no tick
  // stream unless we ask. POST is idempotent and LRU-pooled server-side.
  useEffect(() => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    api
      .post(
        // Empty {} body — axios sends `null` otherwise, which Express
        // body-parser rejects with strict-mode "not valid JSON" → 400.
        `/market-data/instruments/${selectedSymbol.token}/watch`,
        {},
        { params: { exchange: selectedSymbol.exchange } },
      )
      .catch(() => {
        // Soft failure — historical chart still works, live updates just
        // won't flow for this symbol. Don't surface to user.
      });
  }, [selectedSymbol.token, selectedSymbol.exchange]);

  // Drive the per-user server feed: exactly one unsubscribe (old) + one
  // subscribe (new) per symbol switch.
  useEffect(() => {
    const token = selectedSymbol.token;
    const next = token && token !== '0' ? token : null;
    const delta = computeSubscriptionDelta(subscribedTokenRef.current, next);
    if (delta.remove.length > 0) wsService.emitUnsubscribe(delta.remove);
    if (delta.add.length > 0) wsService.emitSubscribe(delta.add);
    subscribedTokenRef.current = next;
  }, [selectedSymbol.token]);

  // Unmount cleanup: release the token so the per-user subscription pool
  // doesn't leak. Separate empty-deps effect so it fires ONLY on unmount (a
  // symbol switch is handled by the delta effect above, which must not
  // unsubscribe the new token). Reads the live ref, not a closed-over token.
  useEffect(() => {
    return () => {
      if (subscribedTokenRef.current) {
        wsService.emitUnsubscribe([subscribedTokenRef.current]);
      }
    };
  }, []);

  // On a reconnecting -> live transition the feed dropped and came back, so
  // bars that closed during the gap never reached us. Gap-fill once.
  useEffect(() => {
    const unsub = wsService.subscribe('feed-state', (data) => {
      // Server emits the FeedState as a bare string; tolerate a { state }
      // wrapper defensively in case the wire shape ever changes.
      const next = (
        typeof data === 'string' ? data : (data as { state?: string } | null)?.state
      ) as FeedState | undefined;
      if (!next) return;
      const prev = prevFeedStateRef.current;
      prevFeedStateRef.current = next;
      setFeedState(next);
      if (next === 'live' && prev === 'reconnecting') void liveEdgeRefresh();
    });
    return unsub;
  }, [liveEdgeRefresh]);

  // Live ticks. The handler only converts the wire payload and dispatches —
  // all series logic lives in the pure `applyTick`.
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      const tick = data as TickData;
      if (tick.token !== selectedSymbol.token) return;
      if (!(typeof tick.ltp === 'number' && tick.ltp > 0)) return;
      setCurrentPrice(tick.ltp);
      dispatch({
        type: 'tick',
        epoch: epochRef.current,
        tick: {
          time: new Date(tick.timestamp).getTime() / 1000,
          price: tick.ltp,
          volume: tick.volume,
        },
      });
    });

    // Server-side closed-candle events (CandleAggregator). Same merge path as
    // the REST poll — the broker timestamp is authoritative either way.
    // NOTE: currently UNFED — nothing calls the gateway's emitCandleToUser in
    // the per-user feed. Kept (harmless) for when that emitter is wired.
    const unsubCandle = wsService.subscribe('candle', (data) => {
      const candle = data as {
        token: string;
        timeframe: string;
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      };
      if (candle.token !== selectedSymbol.token) return;
      if (candle.timeframe !== timeframe) return;
      dispatch({
        type: 'rest',
        epoch: epochRef.current,
        bars: [
          {
            time: new Date(candle.timestamp).getTime() / 1000,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
        ],
      });
    });

    return () => {
      unsubTick();
      unsubCandle();
    };
  }, [selectedSymbol.token, timeframe]);

  return {
    candles: series.bars,
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
  };
}
