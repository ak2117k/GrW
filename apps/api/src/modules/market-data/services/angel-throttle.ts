/**
 * Angel One historical-endpoint throttle handling, shared by BOTH broker
 * paths: the singleton `AngelOneAdapterService` and the per-user
 * `UserFeedSession`.
 *
 * WHY SHARED: the resilience below was built for the singleton adapter, and
 * when the chart's candle path migrated to per-user broker sessions it was
 * not carried across. The per-user session treated a throttle as "no data"
 * and moved on, so every throttled chunk became a permanent, silent hole in
 * the chart — missing candles with nothing in the logs. Keeping one copy is
 * what stops that from drifting apart again.
 */

/**
 * Thrown when Angel One's historical endpoint responds with `data: null`
 * (as opposed to `data: []`). Empirically this is the throttle / auth-
 * rejection shape — Angel returns HTTP 200 with a null `data` field and a
 * `message` like "Access denied because of exceeding access rate". A genuine
 * "no candles in this window" response is `data: []`.
 *
 * Surfacing this as a distinct, named error lets callers tell "the broker
 * throttled us" apart from "no data" — the former is transient and worth
 * retrying, the latter is final. The `name` is set explicitly so the marker
 * survives serialization / `instanceof` across module boundaries.
 */
export class AngelThrottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AngelThrottleError';
    // Restore prototype chain — required when targeting ES5/ES2015 down-level.
    Object.setPrototypeOf(this, AngelThrottleError.prototype);
  }
}

/**
 * Minimum gap between successive historical calls. Angel One's historical
 * limit is 3 req/sec → 350ms keeps us under it.
 *
 * The per-user session previously used 300ms, which is 3.33 req/sec — over
 * the limit by construction, so its own chunk loop provoked the throttling
 * that then ate candles.
 */
export const HISTORICAL_MIN_GAP_MS = 350;

/**
 * Backoff schedule for retrying a throttled chunk. The array length is the
 * retry count; each entry is the delay BEFORE that retry. `[1000, 2000]` →
 * wait ~1s and retry; if that also throttles, wait ~2s and retry once more.
 * A throttle still standing after the last retry is terminal for that chunk.
 * Non-throttle errors are never retried.
 */
export const HISTORICAL_THROTTLE_RETRY_DELAYS_MS = [1000, 2000];

/**
 * Angel's historical `data` field -> rows, distinguishing throttle from
 * no-data.
 *
 * @throws AngelThrottleError when `data` is null/undefined (the throttle
 *         shape). `data: []` returns `[]` — a genuine empty window.
 */
export function rowsOrThrottle(data: unknown, context: string): unknown[] {
  if (data == null) {
    throw new AngelThrottleError(
      `Angel One returned data:null for ${context} (throttled or rejected)`,
    );
  }
  // Anything else non-array is malformed rather than throttled — treat as an
  // empty window rather than retrying something that will never succeed.
  return Array.isArray(data) ? data : [];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ResilientChunkOptions {
  /** Gap between successive broker calls. Defaults to HISTORICAL_MIN_GAP_MS. */
  gapMs?: number;
  /** Delay before each retry. Defaults to HISTORICAL_THROTTLE_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onWarn?: (message: string) => void;
}

export interface ResilientChunkResult<T> {
  items: T[];
  /** Chunks abandoned after their retries were exhausted. */
  dropped: number;
  /** Chunks attempted. */
  attempted: number;
}

/**
 * Run `fetchChunk` over each window with rate pacing and per-chunk throttle
 * retries, returning everything that succeeded.
 *
 * A chunk still throttling after its retries is DROPPED and counted rather
 * than failing the whole fetch — one throttled window should yield a partial
 * series, not an empty chart. Callers are expected to pass `windows` ordered
 * NEWEST-FIRST so a dropped chunk is the oldest (far-left history) and never
 * the recent candles the chart actually needs.
 *
 * Non-throttle errors propagate: they are genuine failures, not transient.
 */
export async function fetchChunksResilient<T>(
  windows: ReadonlyArray<{ start: number; end: number }>,
  fetchChunk: (start: number, end: number) => Promise<T[]>,
  opts: ResilientChunkOptions = {},
): Promise<ResilientChunkResult<T>> {
  const gapMs = opts.gapMs ?? HISTORICAL_MIN_GAP_MS;
  const retryDelays = opts.retryDelaysMs ?? HISTORICAL_THROTTLE_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const warn = opts.onWarn ?? (() => {});

  const items: T[] = [];
  let dropped = 0;
  let attempted = 0;
  let first = true;

  for (const { start, end } of windows) {
    if (!first) await sleep(gapMs);
    first = false;
    attempted++;

    let chunk: T[] | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        chunk = await fetchChunk(start, end);
        break;
      } catch (err) {
        if (!(err instanceof AngelThrottleError)) throw err;
        if (attempt >= retryDelays.length) {
          dropped++;
          warn(
            `Dropping throttled chunk ${new Date(start).toISOString()} → ` +
              `${new Date(end).toISOString()} after ${retryDelays.length} retries — ` +
              `keeping the other chunks (partial result): ${err.message}`,
          );
          break;
        }
        const delayMs = retryDelays[attempt];
        warn(
          `Historical chunk throttled (${new Date(start).toISOString()} → ` +
            `${new Date(end).toISOString()}) — retry ${attempt + 1}/` +
            `${retryDelays.length} in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
    if (chunk) items.push(...chunk);
  }

  return { items, dropped, attempted };
}
