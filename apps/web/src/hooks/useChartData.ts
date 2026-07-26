import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { useChartStore } from '@/stores/chart-store';
import { prependOlderCandles } from '@/utils/chartHistory';
import type { Candle, OIData } from '@/types';

/**
 * Per-user broker-feed lifecycle state, mirrored from the backend
 * `FeedState` (apps/api/.../user-feed.types.ts). The server emits one of
 * these over the `'feed-state'` socket event scoped to the user's room.
 * Task 9 renders this as the chart's live/reconnecting badge.
 */
export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

/**
 * The per-user tick payload emitted on the `'tick'` socket event. Mirrors
 * the backend `TickData` (apps/api/.../broker-adapter.interface.ts) — prices
 * are in RUPEES and `timestamp` arrives as an ISO string over socket.io (it
 * is a `Date` on the server). This is NOT a `Quote`: there is no
 * `change`/`changePercent`/`exchange`/`vwap`; the day-change baseline comes
 * from the separate `/quote` REST call in this hook.
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

interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartOIData {
  time: number;
  value: number;
}

interface UseChartDataReturn {
  candles: ChartCandle[];
  oiData: ChartOIData[];
  isLoading: boolean;
  error: string | null;
  currentPrice: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  // Maps compressed candle times (what's actually plotted) back to the real
  // unix timestamps. Used by CandlestickChart to format axis labels and
  // crosshair tooltips so they show actual market times even though the
  // chart's time axis is gap-collapsed for visual continuity.
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
  // Latest per-user broker-feed lifecycle state (from the 'feed-state' socket
  // event). Task 9 renders this as the chart's live/reconnecting badge.
  feedState: FeedState;
}

/**
 * Walk the time-sorted candle list and collapse any inter-candle gap that
 * exceeds 2× the timeframe (i.e. anything bigger than a normal "next bar")
 * down to a single timeframe. Result: overnight + weekend + holiday gaps
 * become one-bar visual breaks instead of huge empty stretches that make
 * intraday charts look broken.
 *
 * Returns the remapped candles plus a Map from compressed time → real time
 * so the chart can label axes/crosshairs with the actual market time.
 */
function compressTimes<T extends { time: number }>(
  items: T[],
  tfSec: number,
): { compressed: T[]; realByCompressed: Map<number, number> } {
  const realByCompressed = new Map<number, number>();
  if (items.length === 0) return { compressed: [], realByCompressed };

  const compressed: T[] = [];
  let offset = 0;
  let prevReal = items[0].time;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const gap = item.time - prevReal;
      if (gap > tfSec * 2) {
        // Collapse the oversized gap down to one timeframe.
        offset += gap - tfSec;
      }
    }
    prevReal = item.time;
    const compressedTime = item.time - offset;
    compressed.push({ ...item, time: compressedTime });
    realByCompressed.set(compressedTime, item.time);
  }
  return { compressed, realByCompressed };
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
  // slice). The lazy `loadOlder`/`prependOlderCandles` path fetches older
  // history on scroll, so shrinking the initial window defers — not loses —
  // history while cutting cold-load chunk count dramatically.
  //
  // ~bars-per-trading-day (NSE 6.25h session): 1m≈375, 5m≈75, 15m≈25.
  // Windows below keep ≳100 bars after weekends/holidays are excluded.
  const map: Record<string, number> = {
    '1m': 1,    // ~375 bars/day → 1 day fills the 100-bar view (was 3 → 3 chunks)
    '5m': 3,    // ~150 bars over ~2 trading days (was 10 → ~10 chunks)
    '15m': 5,   // ~100-125 bars over ~4 trading days (was 15 → ~15 chunks)
    '30m': 30,  // hour+ intervals fetch in one wide chunk — no per-day penalty
    '1h': 60,   // ~390 bars
    '4h': 120,  // ~180 bars
    '1d': 365,
    '1w': 730,
  };
  return map[timeframe] ?? 3;
}

function candleToChart(c: Candle): ChartCandle {
  const ts = new Date(c.timestamp).getTime() / 1000;
  return {
    time: ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

/**
 * Raw API candles → sorted, time-deduped, "meaningful" ChartCandles (REAL
 * times, before gap-compression). Drops ghost bars (no range AND no body) and
 * any with non-positive prices. Shared by the initial fetch and loadOlder.
 */
function cleanCandles(raw: Candle[]): ChartCandle[] {
  const chartCandles = raw.map(candleToChart).sort((a, b) => a.time - b.time);
  const seen = new Set<number>();
  const deduped = chartCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
  return deduped.filter((c) => {
    const noRange = c.high === c.low;
    const noBody = c.open === c.close;
    if (noRange && noBody) return false;
    if (c.open <= 0 || c.close <= 0 || c.high <= 0 || c.low <= 0) return false;
    return true;
  });
}

export function useChartData(): UseChartDataReturn {
  const selectedSymbol = useChartStore((s) => s.selectedSymbol);
  const timeframe = useChartStore((s) => s.timeframe);
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [oiData, setOiData] = useState<ChartOIData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceChangePercent, setPriceChangePercent] = useState<number | null>(null);
  const candlesRef = useRef<ChartCandle[]>([]);
  const timeframeMsRef = useRef(getTimeframeDurationMs(timeframe));
  const [realTimeMap, setRealTimeMap] = useState<Map<number, number>>(new Map());
  // Mirror of realTimeMap kept in a ref so loadOlder (and the prepend helper)
  // can read the current compressed→real map without a stale closure.
  const realTimeMapRef = useRef<Map<number, number>>(new Map());
  // Infinite-history state. realCandlesRef holds the full REAL-time candle
  // series (uncompressed times); oldestRealRef is the oldest real second we
  // hold, the cursor for the next older fetch.
  const realCandlesRef = useRef<ChartCandle[]>([]);
  const oldestRealRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [prependSeq, setPrependSeq] = useState(0);
  // Per-user broker-feed lifecycle, driven by the 'feed-state' socket event.
  const [feedState, setFeedState] = useState<FeedState>('connecting');
  // Previous feed-state, so we can detect a reconnecting → live transition and
  // gap-fill missed bars exactly once. Kept in a ref (not state) so the change
  // is observed synchronously inside the event handler.
  const prevFeedStateRef = useRef<FeedState | null>(null);
  // The token currently subscribed on the per-user server feed. Drives the
  // subscribe/unsubscribe delta on symbol switch and the unmount cleanup.
  const subscribedTokenRef = useRef<string | null>(null);
  // Live-update path needs to know the real-time bucket of the most-recent
  // bar so a new tick can decide "extend last bar" vs "append a new one".
  const lastRealBucketRef = useRef<number>(0);
  // Monotonic id stamped on each fetchCandles call. Only the latest may apply
  // its response — guards against a slow earlier fetch (e.g. the default 15m,
  // which chunks into many rate-limited requests) resolving AFTER a newer one
  // (e.g. the switched-to 1h, a single fast request) and overwriting it. That
  // race left the chart showing 15m candles/times under a "1H" selection.
  const fetchIdRef = useRef(0);

  // Fetch historical candles
  const fetchCandles = useCallback(async () => {
    const myFetchId = ++fetchIdRef.current;
    // Reset state synchronously BEFORE awaiting the API. The previous
    // symbol's candles must not be visible — and crucially, must not be
    // mutated by incoming live ticks — while this fetch is in flight.
    // Without this, switching from a high-priced symbol (e.g. NIFTY ~24k)
    // to a low-priced one (CRUDEOIL ~9k) produces a hybrid candle:
    // NIFTY's open/high preserved, CRUDEOIL's tick extending close/low.
    setCandles([]);
    candlesRef.current = [];
    lastRealBucketRef.current = 0;
    setRealTimeMap(new Map());
    realTimeMapRef.current = new Map();
    // Reset infinite-history state for the new symbol/timeframe. prependSeq is
    // intentionally NOT reset — the chart treats a prependSeq change as "preserve
    // scroll"; a symbol switch must read as a reset (default-zoom), so it must
    // leave prependSeq unchanged.
    realCandlesRef.current = [];
    oldestRealRef.current = null;
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

      // Stale-response guard: a newer fetch (symbol/timeframe switch) started
      // while this one was awaiting. Discard so a slow older-window response
      // can't clobber the current chart's candles + realTimeMap.
      if (myFetchId !== fetchIdRef.current) return;

      const rawCandles: Candle[] = response.data?.candles ?? response.data?.data ?? [];
      // Sorted, deduped, ghost/bad-price-filtered REAL-time candles.
      const meaningful = cleanCandles(rawCandles);

      // Compress overnight/weekend gaps so candles render contiguously.
      const tfSec = timeframeMsRef.current / 1000;
      const { compressed, realByCompressed } = compressTimes(meaningful, tfSec);

      // Visible signal in devtools console so we can confirm the compression
      // path is running on a hard refresh — if you don't see this line, the
      // tab is serving a stale build.
      // eslint-disable-next-line no-console
      console.log(
        `[useChartData] ${selectedSymbol.symbol} ${timeframe}: raw=${rawCandles.length} kept=${meaningful.length} compressed=${compressed.length} realGapsCollapsed=${realByCompressed.size > 0 ? realByCompressed.size - 1 : 0}`,
      );

      // GAP DIAGNOSTIC: walk the REAL-time series and report every hole larger
      // than 2× the timeframe (i.e. anything that isn't a normal next-bar step).
      // A hole that straddles an overnight/weekend boundary is EXPECTED; a hole
      // WITHIN a single trading session means Angel silently dropped candles
      // (throttled chunk) — that's the "10:00 → 15:30 jump" the user sees.
      // This tells us exactly which case we're in without guessing.
      {
        const fmt = (sec: number) =>
          new Date(sec * 1000).toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        const holes: string[] = [];
        for (let i = 1; i < meaningful.length; i++) {
          const gap = meaningful[i].time - meaningful[i - 1].time;
          if (gap > tfSec * 2) {
            const bars = Math.round(gap / tfSec) - 1;
            holes.push(
              `${fmt(meaningful[i - 1].time)} → ${fmt(meaningful[i].time)} (~${bars} bars missing)`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(
          `[useChartData] ${selectedSymbol.symbol} range: ${meaningful.length > 0 ? fmt(meaningful[0].time) : 'n/a'} → ${meaningful.length > 0 ? fmt(meaningful[meaningful.length - 1].time) : 'n/a'} | ${holes.length} hole(s):`,
          holes,
        );
      }

      setCandles(compressed);
      candlesRef.current = compressed;
      setRealTimeMap(realByCompressed);
      realTimeMapRef.current = realByCompressed;
      // Seed the infinite-history cursor with the full real-time series.
      realCandlesRef.current = meaningful;
      oldestRealRef.current = meaningful.length > 0 ? meaningful[0].time : null;
      hasMoreRef.current = true;

      // Track the most-recent bar's real-time bucket so the WebSocket tick
      // handler can decide whether a new tick extends it or starts a new bar.
      if (meaningful.length > 0) {
        const lastReal = meaningful[meaningful.length - 1].time;
        lastRealBucketRef.current = Math.floor(lastReal / tfSec) * tfSec;
      } else {
        lastRealBucketRef.current = 0;
      }

      if (meaningful.length > 0) {
        const last = meaningful[meaningful.length - 1];
        setCurrentPrice(last.close);
        // Fetch the live quote to get the CORRECT daily change baseline
        // (previous-trading-day close). The previous logic used the FIRST
        // candle in the chart's multi-day window — which on a 7d view of
        // NIFTY meant "comparing today to a week ago", showing -2.77% even
        // when today's actual move was +0.14%.
        try {
          const quoteResp = await api.get(
            `/market-data/instruments/${selectedSymbol.token}/quote`,
            { params: { exchange: selectedSymbol.exchange } },
          );
          const q = quoteResp.data?.quote;
          if (q && typeof q.change === 'number' && typeof q.changePercent === 'number') {
            setPriceChange(q.change);
            setPriceChangePercent(q.changePercent);
            if (typeof q.ltp === 'number' && q.ltp > 0) {
              setCurrentPrice(q.ltp);
            }
          }
        } catch {
          // Quote fetch failed — leave price/change unset rather than show
          // a wrong "across multi-day chart range" value. WS tick will
          // populate them once live ticks resume.
        }
      }
    } catch (err) {
      // Don't let a stale fetch's failure clear the current chart's candles.
      if (myFetchId !== fetchIdRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to fetch candles';
      setError(msg);
      setCandles([]);
      candlesRef.current = [];
    } finally {
      // Only the latest fetch owns the loading flag.
      if (myFetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe]);

  // Infinite history: fetch the chunk of candles immediately older than what we
  // currently hold and prepend it, keeping the existing bars' compressed times
  // unchanged (the chart restores scroll position off the prependSeq bump).
  // Guards prevent concurrent pulls and stop once history is exhausted.
  const loadOlder = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const oldest = oldestRealRef.current;
    if (oldest == null) return;

    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const days = getHistoryRangeDays(timeframe);
      const toMs = (oldest - 1) * 1000; // just before our current oldest real candle
      const to = new Date(toMs).toISOString();
      const from = new Date(toMs - days * 24 * 60 * 60 * 1000).toISOString();

      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        { params: { timeframe, from, to, exchange: selectedSymbol.exchange } },
      );
      const rawOlder: Candle[] = response.data?.candles ?? response.data?.data ?? [];
      const olderMeaningful = cleanCandles(rawOlder).filter((c) => c.time < oldest);

      if (olderMeaningful.length === 0) {
        hasMoreRef.current = false;
        setHasMoreHistory(false);
        return;
      }

      const tfSec = timeframeMsRef.current / 1000;
      const { candles: merged, realTimeMap: newMap, prependedCount } = prependOlderCandles(
        candlesRef.current,
        realTimeMapRef.current,
        olderMeaningful,
        tfSec,
      );
      if (prependedCount === 0) {
        hasMoreRef.current = false;
        setHasMoreHistory(false);
        return;
      }

      realCandlesRef.current = [...olderMeaningful, ...realCandlesRef.current];
      oldestRealRef.current = olderMeaningful[0].time;
      candlesRef.current = merged;
      realTimeMapRef.current = newMap;
      setCandles(merged);
      setRealTimeMap(newMap);
      setPrependSeq((s) => s + 1);
    } catch {
      // Soft failure — leave hasMore true so a later pan can retry.
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [timeframe, selectedSymbol.token, selectedSymbol.exchange]);

  // Fetch OI data. Defensive unwrap with Array.isArray guard so a backend
  // shape change (e.g. wrapping in `{ oi: [...] }`) surfaces as a console
  // warning instead of silently calling .map on a non-array.
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
    timeframeMsRef.current = getTimeframeDurationMs(timeframe);
    fetchCandles();
    fetchOI();
  }, [fetchCandles, fetchOI, timeframe]);

  // Ensure the symbol is subscribed to the live tick feed. The backend
  // boots with a hardcoded universe (~30 tokens) so anything outside
  // that — ONGC, SBIN, any stock from search — has no live tick stream
  // unless we explicitly ask the backend to subscribe it. POST is
  // idempotent and managed by an LRU pool on the backend; opening many
  // charts won't run away with broker slot budget.
  useEffect(() => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    api
      .post(
        // Empty {} body — axios sends `null` otherwise, which Express
        // body-parser rejects with strict-mode "not valid JSON" → 400.
        // The endpoint has no @Body() decorator; the empty object is ignored.
        `/market-data/instruments/${selectedSymbol.token}/watch`,
        {},
        { params: { exchange: selectedSymbol.exchange } },
      )
      .catch(() => {
        // Soft failure — historical chart still works, live updates
        // just won't flow for this symbol. Don't surface to user.
      });
  }, [selectedSymbol.token, selectedSymbol.exchange]);

  // Merge a batch of freshly-fetched REAL-time candles onto the compressed
  // axis. Used by the live-edge REST poll below (and mirrors the single-candle
  // logic in the WS 'candle' handler). Processes candles ascending: any bucket
  // OLDER than our current last bar is skipped (already have it); a bucket that
  // EQUALS the last bar replaces its OHLC (finalises a still-forming bar); a
  // NEWER bucket appends at lastCompressed + tfSec. All new compressed→real
  // mappings are applied in one setRealTimeMap call. Done in ONE setCandles
  // updater so lastRealBucket advances correctly across the whole batch (a
  // per-candle loop would read a stale ref between iterations).
  const applyClosedCandles = useCallback(
    (reals: ChartCandle[]) => {
      if (reals.length === 0) return;
      const tfSec = timeframeMsRef.current / 1000;
      setCandles((prev) => {
        if (prev.length === 0) return prev; // cold start owned by fetchCandles
        const next = prev.slice();
        let curBucket = lastRealBucketRef.current;
        let lastCompressed = next[next.length - 1].time;
        const mapAdditions: Array<[number, number]> = [];
        let changed = false;

        for (const rc of reals) {
          const bucket = Math.floor(rc.time / tfSec) * tfSec;
          if (bucket < curBucket) continue;
          if (bucket === curBucket) {
            const last = next[next.length - 1];
            // Only replace if something actually differs — avoids needless
            // re-renders when the poll returns the same last completed bar.
            if (
              last.open !== rc.open || last.high !== rc.high ||
              last.low !== rc.low || last.close !== rc.close ||
              last.volume !== rc.volume
            ) {
              next[next.length - 1] = { ...last, open: rc.open, high: rc.high, low: rc.low, close: rc.close, volume: rc.volume };
              changed = true;
            }
          } else {
            const compressedTime = lastCompressed + tfSec;
            next.push({
              time: compressedTime,
              open: rc.open,
              high: rc.high,
              low: rc.low,
              close: rc.close,
              volume: rc.volume,
            });
            mapAdditions.push([compressedTime, bucket]);
            lastCompressed = compressedTime;
            curBucket = bucket;
            changed = true;
          }
        }

        if (!changed) return prev;
        if (mapAdditions.length > 0) {
          setRealTimeMap((m) => {
            const nm = new Map(m);
            for (const [ct, b] of mapAdditions) nm.set(ct, b);
            realTimeMapRef.current = nm;
            return nm;
          });
          lastRealBucketRef.current = curBucket;
        }
        candlesRef.current = next;
        return next;
      });
    },
    [],
  );

  // Live-edge REST refresh. The completed-candle series must advance with the
  // live market even when the WS tick/candle feed doesn't reach the browser
  // (Cloudflare polling-transport stalls) — otherwise the chart freezes at
  // load-time's last bar while the LTP (fed by the other REST polls) keeps
  // moving. Fetches a SMALL recent window and merges only the new completed
  // bars. Scoped narrow (1 chunk) + paused when the tab is hidden to keep
  // Angel's ~3/s historical budget clear. This is the belt-and-suspenders twin
  // of useWatchlistQuotes / useCommodities, for candles.
  //
  // Single-sourced as a callback so BOTH the 20s poll below AND the
  // reconnecting → live gap-fill (in the feed-state effect) invoke the exact
  // same fetch — no duplicated fetch/merge logic.
  const liveEdgeRefresh = useCallback(async () => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    // Enough lookback to always include the current session tail (crude/NSE
    // sessions are < 6.5h to lunch; 8h covers the whole day for intraday TFs).
    const WINDOW_MS = 8 * 60 * 60 * 1000;
    try {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - WINDOW_MS).toISOString();
      const response = await api.get(
        `/market-data/instruments/${selectedSymbol.token}/candles`,
        { params: { timeframe, from, to, exchange: selectedSymbol.exchange } },
      );
      const raw: Candle[] = response.data?.candles ?? response.data?.data ?? [];
      const meaningful = cleanCandles(raw);
      applyClosedCandles(meaningful);
    } catch {
      // Soft failure — the next tick or poll will catch up.
    }
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe, applyClosedCandles]);

  useEffect(() => {
    if (!selectedSymbol.token || selectedSymbol.token === '0') return;
    const REFRESH_MS = 20_000;
    const id = setInterval(liveEdgeRefresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [selectedSymbol.token, liveEdgeRefresh]);

  // Drive the per-user server feed for this chart's symbol. On every symbol
  // switch we diff the previous vs next token and emit exactly one
  // unsubscribe (old) + one subscribe (new); without an explicit subscribe the
  // server streams no ticks for this token. Guard empty/'0' like the sibling
  // effects. wsService remembers the token and replays it on reconnect.
  useEffect(() => {
    const token = selectedSymbol.token;
    const next = token && token !== '0' ? token : null;
    const delta = computeSubscriptionDelta(subscribedTokenRef.current, next);
    if (delta.remove.length > 0) wsService.emitUnsubscribe(delta.remove);
    if (delta.add.length > 0) wsService.emitSubscribe(delta.add);
    subscribedTokenRef.current = next;
  }, [selectedSymbol.token]);

  // Unmount cleanup: release the current token from the server feed so the
  // per-user subscription pool doesn't leak when the chart is torn down.
  // Separate empty-deps effect so it fires ONLY on unmount (a symbol switch is
  // handled by the delta effect above, which must not unsubscribe the new
  // token). Reads the live ref, not a closed-over token.
  useEffect(() => {
    return () => {
      if (subscribedTokenRef.current) {
        wsService.emitUnsubscribe([subscribedTokenRef.current]);
      }
    };
  }, []);

  // Track the per-user broker-feed lifecycle. On a reconnecting → live
  // transition, the feed dropped and came back, so any bars that closed during
  // the gap never reached us — trigger the live-edge REST refetch ONCE to
  // gap-fill them (the same fetch the 20s poll uses).
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
      if (next === 'live' && prev === 'reconnecting') {
        void liveEdgeRefresh();
      }
    });
    return unsub;
  }, [liveEdgeRefresh]);

  // Subscribe to WebSocket tick updates for real-time candle building.
  // Live updates have to play nicely with the compressed-time axis: a tick
  // arriving at real time T either extends the current bar (same real-time
  // bucket as the last bar's bucket) or starts a new bar appended at
  // lastCompressedTime + tfSec, regardless of how much real time elapsed.
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      // Per-user 'tick' payload is a TickData (prices in rupees, timestamp an
      // ISO string) — NOT a Quote. There is no change/changePercent here; the
      // day-change baseline is owned by the separate /quote REST call above.
      const tick = data as TickData;
      if (tick.token !== selectedSymbol.token) return;

      const price = tick.ltp;
      setCurrentPrice(price);

      setCandles((prev) => {
        if (prev.length === 0) return prev;

        const tickTime = new Date(tick.timestamp).getTime() / 1000;
        const tfSec = timeframeMsRef.current / 1000;
        const tickRealBucket = Math.floor(tickTime / tfSec) * tfSec;

        const last = prev[prev.length - 1];

        if (tickRealBucket === lastRealBucketRef.current) {
          // Same real-time bucket → extend the last bar in place.
          const updated: ChartCandle = {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volume: last.volume + (tick.volume ?? 0),
          };
          const next = [...prev.slice(0, -1), updated];
          candlesRef.current = next;
          return next;
        } else if (tickRealBucket > lastRealBucketRef.current) {
          // New real-time bucket → append at the next compressed slot
          // (regardless of whether real time skipped overnight/weekend).
          const newCompressedTime = last.time + tfSec;
          setRealTimeMap((m) => {
            const next = new Map(m);
            next.set(newCompressedTime, tickRealBucket);
            realTimeMapRef.current = next;
            return next;
          });
          lastRealBucketRef.current = tickRealBucket;
          const newCandle: ChartCandle = {
            time: newCompressedTime,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: tick.volume ?? 0,
          };
          const next = [...prev, newCandle];
          candlesRef.current = next;
          return next;
        }

        return prev;
      });
    });

    // Subscribe to server-side closed candle events (emitted by CandleAggregator).
    // These also need to land on the compressed time axis. We map the real
    // candle timestamp to its bucket, then either replace (if it matches the
    // most-recent bar's bucket) or append at the next compressed slot.
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

      const tfSec = timeframeMsRef.current / 1000;
      const realBucket = Math.floor(new Date(candle.timestamp).getTime() / 1000 / tfSec) * tfSec;

      setCandles((prev) => {
        if (prev.length === 0) {
          // First bar — synthesize a starting compressed time.
          const start = realBucket;
          const newCandle: ChartCandle = {
            time: start,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          setRealTimeMap((m) => {
            const nm = new Map(m);
            nm.set(start, realBucket);
            realTimeMapRef.current = nm;
            return nm;
          });
          lastRealBucketRef.current = realBucket;
          candlesRef.current = [newCandle];
          return [newCandle];
        }

        const last = prev[prev.length - 1];

        if (realBucket === lastRealBucketRef.current) {
          // Replace last bar (server may emit final values for the still-open bar).
          const updated: ChartCandle = {
            time: last.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          const next = [...prev.slice(0, -1), updated];
          candlesRef.current = next;
          return next;
        }

        if (realBucket > lastRealBucketRef.current) {
          const newCompressedTime = last.time + tfSec;
          setRealTimeMap((m) => {
            const nm = new Map(m);
            nm.set(newCompressedTime, realBucket);
            realTimeMapRef.current = nm;
            return nm;
          });
          lastRealBucketRef.current = realBucket;
          const newCandle: ChartCandle = {
            time: newCompressedTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          };
          const next = [...prev, newCandle];
          candlesRef.current = next;
          return next;
        }

        return prev;
      });
    });

    return () => {
      unsubTick();
      unsubCandle();
    };
  }, [selectedSymbol.symbol, selectedSymbol.token, timeframe]);

  return {
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
  };
}