import type { Endpoint, Lane } from './hub.types';

export type GovResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown };

export interface GovRequest<T> {
  endpoint: Endpoint;
  lane: Lane;
  /** Identical keys in flight are merged into one broker call. */
  key?: string;
  /** Give up with `busy` after this long in the queue. Interactive defaults to interactiveDeadlineMs. */
  deadlineMs?: number;
  run: () => Promise<T>;
}

export interface GovernorOptions {
  ratesPerSec: Record<Endpoint, number>;
  interactiveDeadlineMs: number;
  backgroundTrickleMs: number;
  maxBackoffMs: number;
  isMarketHours: () => boolean;
  isThrottle: (err: unknown) => boolean;
}

/** Below Angel One's per-client limits (quote 10/s, candles 3/s, search 1/s, greeks 1/s). */
export const DEFAULT_RATES: Record<Endpoint, number> = {
  quote: 5,
  candles: 2.5,
  search: 0.8,
  greek: 0.8,
};

export interface GovernorMetrics {
  lanes: { depth: number; waitP50Ms: number; waitP95Ms: number }[];
  endpoints: Record<
    Endpoint,
    { callsLastMin: number; throttlesLastHour: number; backoffMs: number }
  >;
}

interface Pending {
  req: GovRequest<unknown>;
  enqueuedAt: number;
  deadlineAt: number | null;
  resolve: (r: GovResult<unknown>) => void;
}

interface EndpointState {
  nextAt: number;
  backoffMs: number;
  backoffUntil: number;
  calls: number[];
  throttles: number[];
}

const WAIT_SAMPLES = 200;
const HOUR_MS = 60 * 60 * 1000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Every REST request to Angel One for market data goes through here: four
 * strict-priority lanes, one budget per endpoint, merged duplicates,
 * deadlines, and throttle back-off that is REPORTED, never swallowed.
 */
export class Governor {
  private readonly lanes: Pending[][] = [[], [], [], []];
  private readonly waits: number[][] = [[], [], [], []];
  private readonly inflight = new Map<string, Promise<GovResult<unknown>>>();
  private readonly endpoints = new Map<Endpoint, EndpointState>();
  private lastBackgroundAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: GovernorOptions) {
    for (const ep of Object.keys(opts.ratesPerSec) as Endpoint[]) {
      this.endpoints.set(ep, { nextAt: 0, backoffMs: 0, backoffUntil: 0, calls: [], throttles: [] });
    }
  }

  submit<T>(req: GovRequest<T>): Promise<GovResult<T>> {
    if (this.disposed) return Promise.resolve({ kind: 'busy' });
    if (req.key) {
      const existing = this.inflight.get(req.key);
      if (existing) return existing as Promise<GovResult<T>>;
    }
    const now = Date.now();
    const deadline =
      req.deadlineMs ?? (req.lane === 1 ? this.opts.interactiveDeadlineMs : undefined);
    const promise = new Promise<GovResult<T>>((resolve) => {
      this.lanes[req.lane].push({
        req: req as GovRequest<unknown>,
        enqueuedAt: now,
        deadlineAt: deadline === undefined ? null : now + deadline,
        resolve: resolve as (r: GovResult<unknown>) => void,
      });
    });
    if (req.key) {
      const key = req.key;
      this.inflight.set(key, promise as Promise<GovResult<unknown>>);
      void promise.then(() => this.inflight.delete(key));
    }
    this.pump();
    return promise;
  }

  metrics(now: number = Date.now()): GovernorMetrics {
    const endpoints = {} as GovernorMetrics['endpoints'];
    for (const [ep, s] of this.endpoints) {
      s.calls = s.calls.filter((t) => t > now - HOUR_MS);
      s.throttles = s.throttles.filter((t) => t > now - HOUR_MS);
      endpoints[ep] = {
        callsLastMin: s.calls.filter((t) => t > now - 60_000).length,
        throttlesLastHour: s.throttles.length,
        backoffMs: Math.max(0, s.backoffUntil - now),
      };
    }
    return {
      lanes: this.lanes.map((q, i) => ({
        depth: q.length,
        waitP50Ms: percentile(this.waits[i], 50),
        waitP95Ms: percentile(this.waits[i], 95),
      })),
      endpoints,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const q of this.lanes) for (const p of q.splice(0)) p.resolve({ kind: 'busy' });
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    this.expireDeadlines(now);
    let started = true;
    while (started) {
      started = false;
      for (let lane = 0; lane < this.lanes.length; lane++) {
        const idx = this.lanes[lane].findIndex((p) => this.eligible(p, lane, now));
        if (idx >= 0) {
          const [p] = this.lanes[lane].splice(idx, 1);
          this.start(p, lane, now);
          started = true;
          break;
        }
      }
    }
    const wake = this.nextWake(now);
    if (wake !== null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(1, wake - now));
    }
  }

  private eligible(p: Pending, lane: number, now: number): boolean {
    const ep = this.endpoints.get(p.req.endpoint);
    if (!ep || now < ep.nextAt || now < ep.backoffUntil) return false;
    if (lane === 3) {
      if (this.lanes[0].length + this.lanes[1].length + this.lanes[2].length > 0) return false;
      if (this.opts.isMarketHours() && now < this.lastBackgroundAt + this.opts.backgroundTrickleMs) {
        return false;
      }
    }
    return true;
  }

  private start(p: Pending, lane: number, now: number): void {
    const ep = this.endpoints.get(p.req.endpoint) as EndpointState;
    ep.nextAt = now + 1000 / this.opts.ratesPerSec[p.req.endpoint];
    ep.calls.push(now);
    const w = this.waits[lane];
    w.push(now - p.enqueuedAt);
    if (w.length > WAIT_SAMPLES) w.shift();
    if (lane === 3) this.lastBackgroundAt = now;

    Promise.resolve()
      .then(() => p.req.run())
      .then(
        (value) => {
          ep.backoffMs = 0;
          p.resolve({ kind: 'ok', value });
        },
        (error) => {
          if (this.opts.isThrottle(error)) {
            const t = Date.now();
            ep.backoffMs = ep.backoffMs
              ? Math.min(ep.backoffMs * 2, this.opts.maxBackoffMs)
              : Math.min(1000, this.opts.maxBackoffMs);
            ep.backoffUntil = t + ep.backoffMs;
            ep.throttles.push(t);
            p.resolve({ kind: 'throttled', retryAfterMs: ep.backoffMs });
          } else {
            p.resolve({ kind: 'error', error });
          }
        },
      )
      .finally(() => this.pump());
  }

  private expireDeadlines(now: number): void {
    for (const q of this.lanes) {
      for (let i = q.length - 1; i >= 0; i--) {
        const p = q[i];
        if (p.deadlineAt !== null && now >= p.deadlineAt) {
          q.splice(i, 1);
          p.resolve({ kind: 'busy' });
        }
      }
    }
  }

  private nextWake(now: number): number | null {
    let wake: number | null = null;
    const consider = (t: number) => {
      if (t > now && (wake === null || t < wake)) wake = t;
    };
    this.lanes.forEach((q, lane) => {
      for (const p of q) {
        const ep = this.endpoints.get(p.req.endpoint);
        if (ep) consider(Math.max(ep.nextAt, ep.backoffUntil));
        if (p.deadlineAt !== null) consider(p.deadlineAt);
        if (lane === 3 && this.opts.isMarketHours()) {
          consider(this.lastBackgroundAt + this.opts.backgroundTrickleMs);
        }
      }
    });
    return wake;
  }
}
