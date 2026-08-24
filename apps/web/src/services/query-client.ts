import { QueryClient } from '@tanstack/react-query';
import { retryDelayMs } from './refresh-policy';

/**
 * The one refresh primitive (F2).
 *
 * Every behaviour below was missing from all 49 hand-rolled `setInterval`
 * loops this replaces, and each one had to be remembered per call site — so it
 * was remembered nowhere. Making them defaults is the entire point: a library
 * was chosen over a fiftieth in-house loop because the loops ARE the defect,
 * and the single one that handled `document.hidden` handled it wrongly.
 *
 * Deliberately NOT set here: `refetchInterval`. Cadence is per-query and must
 * stay market-aware, so call sites pass `marketAwareInterval(ms)` from
 * `refresh-policy`. A blanket interval here would poll a shut market at 03:00,
 * which is the behaviour this program exists to remove.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Tab-return recovery. The audit found zero visibilitychange listeners
      // in the app, which is why a stall only "sometimes" cleared when the
      // user came back: nothing caught up, an interval just happened to fire.
      refetchOnWindowFocus: true,

      // Network-return recovery. Likewise zero `online` listeners existed.
      refetchOnReconnect: true,

      // A backgrounded tab's timers are throttled by the browser, so data can
      // be arbitrarily old on return. Refetching on mount keeps a remount
      // honest rather than painting a stale cache.
      refetchOnMount: true,

      retry: 3,
      retryDelay: retryDelayMs,

      // Short: this is live market data. Long enough that several components
      // mounting the same query in one render pass share a single request.
      staleTime: 2_000,
    },
  },
});
