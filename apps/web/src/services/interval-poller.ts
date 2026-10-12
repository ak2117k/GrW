/** The slice of `document` the poller needs — injectable so it is testable in node. */
export type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export interface VisibilityAwarePoller {
  /** Stop the interval and detach listeners. Idempotent. */
  stop: () => void;
}

/**
 * A framework-free interval poller:
 *  - runs `task` every `intervalMs` (no immediate run — callers load on mount);
 *  - skips a tick when `shouldPoll()` is false (re-evaluated every tick, so a
 *    page left open through the close goes quiet on its own);
 *  - skips while the tab is hidden, and runs once immediately on return;
 *  - never overlaps: a tick is dropped while the previous `task` is in flight;
 *  - swallows `task` rejections (the task owns its error handling).
 *
 * React hooks wrap it in a `useEffect` and call `stop()` in the cleanup.
 */
export function createVisibilityAwarePoller(opts: {
  intervalMs: number;
  task: () => Promise<void> | void;
  shouldPoll: () => boolean;
  /** Defaults to the global `document`; `null` = no visibility handling. */
  doc?: VisibilityDoc | null;
  /**
   * Run once immediately when the tab becomes visible again (default true).
   * Pass false for expensive tasks (a broker login) so tab-flicking cannot
   * trigger a burst — the next interval tick picks it up instead.
   */
  refreshOnVisible?: boolean;
}): VisibilityAwarePoller {
  const doc: VisibilityDoc | null =
    opts.doc !== undefined ? opts.doc : typeof document === 'undefined' ? null : document;

  let stopped = false;
  let inFlight = false;

  const tick = (): void => {
    if (stopped || inFlight) return;
    if (doc && doc.visibilityState === 'hidden') return;
    if (!opts.shouldPoll()) return;
    inFlight = true;
    Promise.resolve()
      .then(() => opts.task())
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const id = setInterval(tick, opts.intervalMs);

  const onVisibility = (): void => {
    if (doc && doc.visibilityState === 'visible') tick();
  };
  const listen = doc !== null && opts.refreshOnVisible !== false;
  if (listen) doc.addEventListener('visibilitychange', onVisibility);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      if (listen) doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
