import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import { createVisibilityAwarePoller, type VisibilityDoc } from '@/services/interval-poller';
import { hasOpenInSessionTracker } from '@/services/portfolio-session';

/**
 * A single per-trade tracker as returned by `GET /api/portfolio/trackers`.
 *
 * This is the EXACT backend contract (`TradeTrackerDto`, spec §5): one persisted
 * tracker per real Angel One position/holding, recording entry, exit, the
 * holding-period extreme high/low, the day's high/low and the latest P&L.
 * Nullable fields are `null` (never `undefined`) — they stay unset until the
 * tick updater / close path fills them. All timestamps are ISO strings.
 */
export interface TradeTracker {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: 'POSITION' | 'HOLDING';
  entryPrice: number;
  qty: number;
  entryTime: string; // ISO
  exitPrice: number | null;
  exitTime: string | null; // ISO | null
  status: 'OPEN' | 'CLOSED';
  holdingHigh: number | null;
  holdingLow: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  updatedAt: string; // ISO
}

interface TrackersResponse {
  trackers: TradeTracker[];
}

export interface UseTradeTrackers {
  data: TradeTracker[] | null;
  loading: boolean;
  /** A human-facing error message for non-404 failures, else null. */
  error: string | null;
  /** True when the backend returned 404 (no Angel One account connected). */
  notConnected: boolean;
  refresh: () => Promise<void>;
}

/** Cadence of the cheap `GET /portfolio/trackers` live poll. */
export const TRACKER_POLL_MS = 5_000;

/**
 * Poll the DB-backed tracker list while there is something live to show.
 *
 * The server-side sweep keeps every OPEN tracker's lastLtp / P&L / high / low
 * current from the live feed, so the page only needs the cheap DB read — never
 * the heavy broker-backed POST /refresh. A tick runs only when at least one
 * OPEN tracker's exchange is in session (an MCX position keeps it going into
 * the evening), the tab is visible, and no POST /refresh is in flight
 * (`isBusy`). Failed polls keep the last good rows. After `stop()` no response
 * is delivered, so an unmounted hook never sets state.
 */
export function startTrackerPolling(opts: {
  get: () => Promise<TradeTracker[]>;
  getTrackers: () => TradeTracker[] | null;
  onData: (trackers: TradeTracker[]) => void;
  isBusy: () => boolean;
  now?: () => Date;
  doc?: VisibilityDoc | null;
  intervalMs?: number;
}): { stop: () => void } {
  const now = opts.now ?? (() => new Date());
  let stopped = false;
  const poller = createVisibilityAwarePoller({
    intervalMs: opts.intervalMs ?? TRACKER_POLL_MS,
    doc: opts.doc,
    shouldPoll: () => !opts.isBusy() && hasOpenInSessionTracker(opts.getTrackers(), now()),
    task: async () => {
      try {
        const rows = await opts.get();
        // Re-check busy: a manual Refresh started mid-poll owns the result.
        if (!stopped && !opts.isBusy()) opts.onData(rows);
      } catch {
        // Transient — keep the last good rows; the next tick retries.
      }
    },
  });
  return {
    stop: () => {
      stopped = true;
      poller.stop();
    },
  };
}

/**
 * Loads the caller's trade trackers (OPEN + CLOSED, newest first). On mount
 * (and via `refresh()`, the manual Refresh button) it runs the heavy
 * POST /refresh backfill; in between it polls the cheap GET every
 * {@link TRACKER_POLL_MS} while an OPEN tracker's exchange is in session, so
 * live price and P&L keep moving (including MCX in the evening). A 404 is
 * mapped to `notConnected` (a normal, non-error state — no broker account
 * linked); any other failure becomes `error`.
 */
export function useTradeTrackers(): UseTradeTrackers {
  const [data, setData] = useState<TradeTracker[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const mountedRef = useRef(true);
  const refreshingRef = useRef(false);
  const dataRef = useRef<TradeTracker[] | null>(null);
  dataRef.current = data;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    refreshingRef.current = true;
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      // POST /refresh BACKFILLS the caller's book (broker snapshot + reconcile)
      // and returns the full list — so opening the page fills previous / ongoing
      // trades instead of showing an empty table before the cron poller runs.
      const { data: res } = await api.post<TrackersResponse>('/portfolio/trackers/refresh');
      if (mountedRef.current) setData(res.trackers ?? []);
    } catch (err) {
      if (!mountedRef.current) return;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setData(null);
        setNotConnected(true);
      } else {
        setError('Could not load your trade trackers. Please try again.');
      }
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live refresh between backfills: the cheap DB read, only while an OPEN
  // tracker's exchange is trading and the tab is visible.
  useEffect(() => {
    const poller = startTrackerPolling({
      get: async () => {
        const { data: res } = await api.get<TrackersResponse>('/portfolio/trackers');
        return res.trackers ?? [];
      },
      getTrackers: () => dataRef.current,
      onData: (rows) => {
        if (mountedRef.current) setData(rows);
      },
      isBusy: () => refreshingRef.current,
    });
    return () => poller.stop();
  }, []);

  return { data, loading, error, notConnected, refresh };
}
