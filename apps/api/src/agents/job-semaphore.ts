/**
 * One job's slots inside an agent container (design §4.3).
 *
 * `limit` calls run at once; up to `maxQueue` more wait in FIFO order. A caller that
 * cannot START before its deadline is rejected — never silently dropped, never left
 * waiting past the point where the API has already given up on it. The rejection is a
 * {@link SemaphoreRejected}; the server turns it into the protocol's `AgentBusyError`.
 *
 * Deliberately dependency-free (no Nest, no SDK) so the agent process stays small.
 */

export type SemaphoreRejectReason = 'queue-full' | 'deadline' | 'cancelled';

export class SemaphoreRejected extends Error {
  constructor(
    readonly reason: SemaphoreRejectReason,
    readonly waitedMs: number,
  ) {
    super(`semaphore: ${reason} after ${waitedMs} ms`);
    this.name = 'SemaphoreRejected';
  }
}

/** Releases the slot. Idempotent: a second call is a no-op. */
export type Release = () => void;

interface Waiter {
  enqueuedAt: number;
  grant: (release: Release) => void;
  reject: (err: SemaphoreRejected) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface AcquireOptions {
  /** Absolute epoch ms by which the call must have STARTED. */
  deadlineAt: number;
  /** Aborting it while still queued removes the waiter (client went away). */
  signal?: AbortSignal;
}

export class JobSemaphore {
  readonly maxQueue: number;
  private running = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly limit: number,
    maxQueue?: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limit) || limit < 1) this.limit = 1;
    this.maxQueue = maxQueue ?? this.limit * 2;
  }

  get inFlight(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(opts: AcquireOptions): Promise<Release> {
    const start = this.now();
    if (opts.signal?.aborted) return Promise.reject(new SemaphoreRejected('cancelled', 0));
    if (this.running < this.limit && this.waiters.length === 0) {
      if (start > opts.deadlineAt) return Promise.reject(new SemaphoreRejected('deadline', 0));
      this.running++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new SemaphoreRejected('queue-full', 0));
    const waitBudget = opts.deadlineAt - start;
    if (waitBudget <= 0) return Promise.reject(new SemaphoreRejected('deadline', 0));

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: start,
        grant: resolve,
        reject,
        timer: null,
      };
      const drop = (reason: SemaphoreRejectReason): void => {
        const i = this.waiters.indexOf(waiter);
        if (i < 0) return; // already granted
        this.waiters.splice(i, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new SemaphoreRejected(reason, this.now() - start));
      };
      const onAbort = (): void => drop('cancelled');
      waiter.timer = setTimeout(() => drop('deadline'), waitBudget);
      waiter.timer.unref?.();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      waiter.grant = (release) => {
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(release);
      };
      this.waiters.push(waiter);
    });
  }

  private releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.running < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.timer) clearTimeout(next.timer);
      this.running++;
      next.grant(this.releaser());
    }
  }
}
