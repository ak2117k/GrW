/**
 * USER-FACING CLAUDE CALLS SHARE ONLY THE SENTINEL'S NON-RESERVED CAPACITY.
 *
 * The trade sentinel runs at most `JUDGE_CONCURRENCY` (2) model calls at once
 * and keeps `LIVE_RESERVED_SLOTS` (1) of them for live exit judgements. Its
 * `runShared` is the door overnight reviews already use: it waits until a slot
 * is free WITHOUT touching the reserved one, then registers the job in the same
 * in-flight map the live tick counts. A News or Advisor request goes through
 * that same door, so:
 *
 *   - it only ever starts when no other model call is in flight (2 - 1 = 1
 *     shared slot), so the live reserved slot is always free for an exit;
 *   - while it runs, the live tick sees it as one in-flight judgement — exactly
 *     like an overnight review — and still has its reserved slot;
 *   - it waits at most `maxWaitMs` for that slot, then fails with
 *     {@link AssistBusyError} ("busy, try again") and is guaranteed never to
 *     start later: `runShared` re-checks `expired` on every wake.
 *
 * Once started, the call is bounded by the CLI transport's own 180 s timeout.
 */

/** The slice of `SentinelCycleService` this needs (kept narrow for tests). */
export interface SharedSlotRunner {
  runShared<T>(
    trackerId: string,
    work: () => Promise<T>,
    opts?: { expired?: () => boolean; reserveLive?: () => boolean },
  ): Promise<T>;
}

export const ASSIST_BUSY_MESSAGE =
  'Claude is busy with live trade decisions right now — please try again in a minute.';

/** No shared slot freed up within the wait budget. Never started; safe to retry. */
export class AssistBusyError extends Error {
  constructor(waitedMs: number) {
    super(`${ASSIST_BUSY_MESSAGE} (no free model slot within ${Math.round(waitedMs / 1000)} s)`);
    this.name = 'AssistBusyError';
  }
}

let seq = 0;

export function runInSharedSlot<T>(
  runner: SharedSlotRunner,
  work: () => Promise<T>,
  opts: { maxWaitMs: number },
): Promise<T> {
  let timedOut = false;
  let started = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (started) return;
      timedOut = true;
      reject(new AssistBusyError(opts.maxWaitMs));
    }, opts.maxWaitMs);
    // A unique id per call: the one-in-flight-per-position rule must not merge
    // two unrelated user questions, and it never collides with a tracker id.
    const id = `assist:${Date.now().toString(36)}:${(seq++).toString(36)}`;
    runner
      .runShared(
        id,
        () => {
          // Runs synchronously right after runShared took the slot, so the
          // timer cannot fire between "slot taken" and "started".
          started = true;
          clearTimeout(timer);
          return work();
        },
        // No `reserveLive` override: the default always keeps the live slot.
        { expired: () => timedOut },
      )
      .then(resolve, (err) => {
        clearTimeout(timer);
        // After a timeout the caller already has its AssistBusyError; the
        // queued job's own rejection (SharedJobExpired on its next wake) is noise.
        if (timedOut) return;
        reject(err);
      });
  });
}
