// apps/api/src/modules/mbm/services/mbm-capture-lane.ts
import { Injectable } from '@nestjs/common';

/**
 * Index-first ordering between the two chain captures, which share the owner's ONE Angel session and
 * its quote budget. While an index tick runs, the per-symbol (stock) capture waits before each of its
 * broker calls; the index capture never waits for stocks. In-process only (one API instance).
 */
@Injectable()
export class MbmCaptureLane {
  private busy = 0;
  private waiters: Array<() => void> = [];

  /** The index tick starts; pair with {@link leaveIndex} in a finally. */
  enterIndex(): void {
    this.busy++;
  }

  leaveIndex(): void {
    this.busy = Math.max(0, this.busy - 1);
    if (this.busy === 0) {
      const w = this.waiters;
      this.waiters = [];
      for (const r of w) r();
    }
  }

  get indexBusy(): boolean {
    return this.busy > 0;
  }

  /** Resolves at once when no index tick runs, else when it ends (or after `maxWaitMs`, so a stuck index tick cannot freeze stocks). */
  whenIndexIdle(maxWaitMs = 60_000): Promise<void> {
    if (this.busy === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, maxWaitMs);
      t.unref?.();
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
