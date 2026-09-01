import { useEffect, useRef } from 'react';
import {
  marketAwareInterval,
  marketPhase,
  shouldRefreshOnReturn,
} from '@/services/refresh-policy';

/**
 * Run a refresh on a market-aware interval, AND catch up when the user returns.
 *
 * The catch-up is the point. The audit behind this work counted 49 hand-rolled
 * `setInterval` loops across 36 files with zero `visibilitychange` listeners and
 * zero `online` listeners — so nothing in the app ever refetches on tab return.
 * A hidden tab's timers are throttled by the browser (Chrome drops them to about
 * one a minute, and can freeze them), which is why data came back stale and why
 * "it sometimes fixes itself" was true: the user happened to return shortly
 * before a timer fired. Otherwise they waited it out and pressed F5.
 *
 * This is deliberately NOT a fiftieth ad-hoc loop. It is one shared primitive
 * reading the same `refresh-policy` the TanStack client uses, for the call sites
 * whose data flows into a reducer rather than into render — where TanStack's
 * fetch/cache/render model does not fit. Simple fetch-to-render hooks should use
 * `useQuery` instead and get this behaviour from the client defaults.
 *
 * `fn` is called with no arguments and its result ignored; it must handle its own
 * errors, exactly as the interval it replaces did.
 */
export function useLiveRefresh(fn: () => void | Promise<void>, baseMs: number): void {
  // Held in a ref so a caller that re-creates `fn` every render (the common case
  // with useCallback dependencies) does not tear down and rebuild the timer and
  // the listeners on each one.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const lastRunAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const run = (): void => {
      if (cancelled) return;
      lastRunAt.current = Date.now();
      void fnRef.current();
    };

    // The interval is re-derived after every tick rather than fixed once, so a
    // chart left open through the close stops polling instead of running all
    // night. `marketAwareInterval` returns false when every venue is shut.
    const nextInterval = marketAwareInterval(baseMs);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      const delay = nextInterval();
      if (delay === false) {
        // Market shut. Re-check on the base cadence -- cheap, and it means the
        // poll resumes by itself at the open without a reload.
        timer = setTimeout(schedule, baseMs);
        return;
      }
      timer = setTimeout(() => {
        run();
        schedule();
      }, delay);
    };

    schedule();

    // Browser-only. These hooks are exercised in a node test environment, where
    // a bare `document` reference throws before anything is scheduled.
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    const catchUp = (): void => {
      const msSinceLastRefresh = lastRunAt.current
        ? Date.now() - lastRunAt.current
        : Number.POSITIVE_INFINITY;
      if (shouldRefreshOnReturn({ msSinceLastRefresh, phase: marketPhase() })) run();
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') catchUp();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', catchUp);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', catchUp);
    };
  }, [baseMs]);
}
