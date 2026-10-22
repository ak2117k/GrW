import { AssistBusyError, runInSharedSlot, type SharedSlotRunner } from './assist-slot';

/**
 * A faithful stand-in for SentinelCycleService.runShared's slot rules:
 * JUDGE_CONCURRENCY = 2, LIVE_RESERVED_SLOTS = 1, waiters re-check on every
 * release, `expired` checked on every wake.
 */
class FakeCycle implements SharedSlotRunner {
  readonly judging = new Set<string>();
  private waiters: Array<() => void> = [];

  /** A live judgement occupying a slot until the returned release is called. */
  live(id: string): () => void {
    this.judging.add(id);
    return () => {
      this.judging.delete(id);
      this.wake();
    };
  }

  async runShared<T>(id: string, work: () => Promise<T>, opts: { expired?: () => boolean } = {}): Promise<T> {
    for (;;) {
      if (opts.expired?.()) throw new Error('SharedJobExpired');
      if (this.judging.size < 2 - 1 && !this.judging.has(id)) break;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.judging.add(id);
    try {
      return await work();
    } finally {
      this.judging.delete(id);
      this.wake();
    }
  }

  private wake(): void {
    for (const r of this.waiters.splice(0)) r();
  }
}

describe('runInSharedSlot', () => {
  it('runs immediately when no model call is in flight, and counts as one in flight while running', async () => {
    const cycle = new FakeCycle();
    let seenInFlight = 0;
    const out = await runInSharedSlot(
      cycle,
      async () => {
        seenInFlight = cycle.judging.size;
        return 'ok';
      },
      { maxWaitMs: 1000 },
    );
    expect(out).toBe('ok');
    expect(seenInFlight).toBe(1); // the live tick sees it and still has its reserved slot
    expect(cycle.judging.size).toBe(0);
  });

  it('never takes the live reserved slot: with one live judgement running it waits, then reports busy', async () => {
    jest.useFakeTimers();
    try {
      const cycle = new FakeCycle();
      const releaseLive = cycle.live('tracker-1');
      const work = jest.fn().mockResolvedValue('should not run');

      const p = runInSharedSlot(cycle, work, { maxWaitMs: 5000 });
      const caught = p.catch((e) => e);
      await jest.advanceTimersByTimeAsync(5000);
      expect(await caught).toBeInstanceOf(AssistBusyError);

      // The slot frees AFTER the timeout: the timed-out call must not start late.
      releaseLive();
      await jest.advanceTimersByTimeAsync(0);
      expect(work).not.toHaveBeenCalled();
      expect(cycle.judging.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts as soon as the live judgement finishes when that is within the wait budget', async () => {
    const cycle = new FakeCycle();
    const releaseLive = cycle.live('tracker-1');
    const p = runInSharedSlot(cycle, async () => 'answered', { maxWaitMs: 5000 });
    setTimeout(releaseLive, 10);
    await expect(p).resolves.toBe('answered');
  });

  it('a second user call queues behind the first instead of taking the second slot', async () => {
    const cycle = new FakeCycle();
    let release!: () => void;
    const first = runInSharedSlot(
      cycle,
      () => new Promise<string>((r) => (release = () => r('first'))),
      { maxWaitMs: 5000 },
    );
    const secondWork = jest.fn().mockResolvedValue('second');
    const second = runInSharedSlot(cycle, secondWork, { maxWaitMs: 5000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(secondWork).not.toHaveBeenCalled();
    expect(cycle.judging.size).toBe(1); // one slot left for a live exit
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('propagates the work error (not busy) when the call itself fails', async () => {
    const cycle = new FakeCycle();
    await expect(
      runInSharedSlot(cycle, () => Promise.reject(new Error('claude CLI: timed out')), { maxWaitMs: 1000 }),
    ).rejects.toThrow('claude CLI: timed out');
  });
});
