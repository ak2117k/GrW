import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { quoteFromTick, tickMatches } from '@/services/browser-feed';
import { useLivePollMs } from './useLivePollMs';

interface QuoteState {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
  isStale: boolean;
  loading: boolean;
}

export interface InstrumentQuote extends QuoteState {
  /**
   * Imperative re-fetch. Additive to the frozen return contract (the wiring
   * agent destructures the named data fields above and is unaffected); exposed
   * so the hook can be unit-tested via the renderToStaticMarkup + invoke-fetch
   * technique the sibling hooks (useZones / useSrEvidence) use.
   */
  refetch: () => void;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const POLL_INTERVAL_MS = 3_000;

const DEFAULT_QUOTE: QuoteState = {
  ltp: 0,
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  change: 0,
  changePct: 0,
  isStale: false,
  loading: false,
};

/**
 * The order ticket header's single-symbol quote. One fetch of
 * `GET /market-data/instruments/:token/quote` on open, then live ticks for
 * (token, exchange) over /ws (subscribed as a viewed chart). The 3 s poll runs
 * only as the fallback: off while the hub feeds this browser and the feed is
 * Live (SP1 M4), on otherwise.
 *
 * The backend wraps the payload as `{ token, quote: { ltp, open, high, low,
 * close, change, changePercent } }` — we unwrap `data.quote` and map
 * `changePercent` -> `changePct`. On error / `ltp <= 0` we mark the quote stale
 * (so the header can render "—") rather than throwing.
 */
export function useInstrumentQuote(
  token: string | null,
  exchange: string | null,
): InstrumentQuote {
  const [quote, setQuote] = useState<QuoteState>(DEFAULT_QUOTE);
  const abortRef = useRef<AbortController | null>(null);
  const pollMs = useLivePollMs(POLL_INTERVAL_MS);

  const fetchQuote = useCallback(async () => {
    // Bail early when we don't have both inputs — nothing to fetch.
    if (!token || !exchange) {
      setQuote(DEFAULT_QUOTE);
      return;
    }

    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setQuote((prev) => ({ ...prev, loading: true }));
    try {
      const response = await api.get(
        `/market-data/instruments/${token}/quote`,
        { signal: controller.signal },
      );
      // A newer fetch superseded this one — don't write stale data.
      if (abortRef.current !== controller) return;

      const q = response.data?.quote ?? {};
      const ltp = Number(q.ltp) || 0;
      setQuote({
        ltp,
        open: Number(q.open) || 0,
        high: Number(q.high) || 0,
        low: Number(q.low) || 0,
        close: Number(q.close) || 0,
        change: Number(q.change) || 0,
        changePct: Number(q.changePercent) || 0,
        // No live price means the header should fall back to "—".
        isStale: ltp <= 0,
        loading: false,
      });
    } catch (err) {
      // Aborted requests are expected on rapid token changes — ignore them.
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') {
        return;
      }
      if (abortRef.current !== controller) return;
      // Fetch failed — mark stale so the header shows "—"; never crash.
      setQuote((prev) => ({ ...prev, isStale: true, loading: false }));
    }
  }, [token, exchange]);

  // Open: one fetch, the live subscription, and tick updates for this instrument.
  useEffect(() => {
    // Reset immediately when inputs clear so the header doesn't show a stale
    // price for the previous symbol during the next fetch.
    if (!token || !exchange) {
      setQuote(DEFAULT_QUOTE);
      return;
    }

    fetchQuote();
    const ref = { token, exchange };
    wsService.emitSubscribe([ref], 'chart');
    const unsubTick = wsService.subscribe('tick', (data) => {
      if (!tickMatches(data, token, exchange)) return;
      setQuote((prev) => {
        const next = quoteFromTick(prev, data);
        return next === prev ? prev : { ...next, isStale: false, loading: false };
      });
    });

    return () => {
      unsubTick();
      wsService.emitUnsubscribe([ref]);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchQuote, token, exchange]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (!token || !exchange || pollMs === false) return;
    const intervalId = window.setInterval(fetchQuote, pollMs);
    return () => window.clearInterval(intervalId);
  }, [fetchQuote, token, exchange, pollMs]);

  return { ...quote, refetch: fetchQuote };
}
