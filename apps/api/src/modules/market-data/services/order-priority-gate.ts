/**
 * Order calls get priority over a user's background data reads (2026-11-10).
 *
 * WHY: prod 2026-11-10 18:50 IST, an exit's MARKET SELL on the owner's account got no
 * answer within the SDK's 7 s (`{}`), while the SAME per-user Angel session was
 * timing out about once a minute on background quote / optionGreek / candle polls.
 * While an order call (or the exit's own order-book / positions read) is in flight
 * for a user, that user's data reads wait instead of competing with it.
 *
 * Never a stall: every hold expires on its own after `maxHoldMs`, and every waiting
 * read goes ahead after `maxHoldMs` whatever the holds do. In-memory, per session.
 */
export const ORDER_PRIORITY_MAX_HOLD_MS = 25_000;

/** What an order path needs: start a hold, get its (idempotent) release. */
export interface OrderPriorityHold {
  begin(): () => void;
}

export class OrderPriorityGate implements OrderPriorityHold {
  private active = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly maxHoldMs = ORDER_PRIORITY_MAX_HOLD_MS) {}

  /** True while at least one order call holds the gate. */
  held(): boolean {
    return this.active > 0;
  }

  /** Hold data reads back until the returned release runs (or `maxHoldMs` passes). */
  begin(): () => void {
    this.active += 1;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) this.flush();
    };
    const timer = setTimeout(release, this.maxHoldMs);
    (timer as { unref?: () => void }).unref?.();
    return release;
  }

  /** Resolves at once when nothing holds the gate; else when every hold ends, at most `maxHoldMs` from now. */
  wait(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.maxHoldMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiters.add(done);
    });
  }

  private flush(): void {
    for (const w of [...this.waiters]) w();
  }
}
