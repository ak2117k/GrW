import type { ProviderName } from '../providers/provider.types';

/** A queued call could not start within its job's `maxWaitMs` (spec §4.4). */
export class AiQueueTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiQueueTimeout';
  }
}

const DEFAULT_LIMITS: Record<ProviderName, number> = { 'claude-cli': 2, 'anthropic-api': 8 };

interface Waiter {
  priority: number;
  seq: number;
  enqueuedAt: number;
  start: () => void;
}

interface Lane {
  limit: number;
  active: number;
  queue: Waiter[];
}

/**
 * One in-process scheduler with a concurrency limit per provider (spec §4.4).
 *
 * When a provider is saturated, waiting calls start in priority order (lower
 * number first) and FIFO within a priority. A call that cannot start within
 * `maxWaitMs` is rejected with `AiQueueTimeout` and its function never runs.
 *
 * PASS-THROUGH WHEN IDLE. With a free slot, `fn` is invoked synchronously
 * inside `run` — no timer, no microtask hop — so today's single caller (the
 * sentinel) sees no added latency and `queuedMs` is exactly 0.
 */
export class PriorityScheduler {
  private readonly lanes = new Map<ProviderName, Lane>();
  private seq = 0;

  constructor(limits: Partial<Record<ProviderName, number>>) {
    for (const name of Object.keys(DEFAULT_LIMITS) as ProviderName[]) {
      const raw = limits[name];
      const limit = raw !== undefined && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_LIMITS[name];
      this.lanes.set(name, { limit, active: 0, queue: [] });
    }
  }

  run<T>(
    provider: ProviderName,
    priority: number,
    maxWaitMs: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; queuedMs: number }> {
    const lane = this.lanes.get(provider);
    if (!lane) return Promise.reject(new Error(`ai-gateway: unknown provider ${provider}`));

    if (lane.active < lane.limit && lane.queue.length === 0) {
      return this.execute(lane, fn, 0);
    }

    return new Promise((resolve, reject) => {
      const enqueuedAt = Date.now();
      const waiter: Waiter = {
        priority,
        seq: this.seq++,
        enqueuedAt,
        start: () => {
          clearTimeout(timer);
          this.execute(lane, fn, Date.now() - enqueuedAt).then(resolve, reject);
        },
      };
      const timer = setTimeout(() => {
        const i = lane.queue.indexOf(waiter);
        if (i >= 0) lane.queue.splice(i, 1);
        reject(
          new AiQueueTimeout(
            `ai-gateway: ${provider} call (priority ${priority}) did not start within ${maxWaitMs} ms`,
          ),
        );
      }, maxWaitMs);
      this.enqueue(lane, waiter);
    });
  }

  private enqueue(lane: Lane, waiter: Waiter): void {
    const i = lane.queue.findIndex(
      (w) => w.priority > waiter.priority || (w.priority === waiter.priority && w.seq > waiter.seq),
    );
    if (i < 0) lane.queue.push(waiter);
    else lane.queue.splice(i, 0, waiter);
  }

  private execute<T>(lane: Lane, fn: () => Promise<T>, queuedMs: number): Promise<{ result: T; queuedMs: number }> {
    lane.active++;
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.then(
      (result) => {
        this.release(lane);
        return { result, queuedMs };
      },
      (err) => {
        this.release(lane);
        throw err;
      },
    );
  }

  private release(lane: Lane): void {
    lane.active--;
    while (lane.active < lane.limit && lane.queue.length > 0) {
      lane.queue.shift()!.start();
    }
  }
}
