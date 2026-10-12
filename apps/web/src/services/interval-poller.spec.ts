import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVisibilityAwarePoller, type VisibilityDoc } from './interval-poller';

/** A minimal stand-in for `document` (tests run in node, no DOM). */
function fakeDoc(initial: 'visible' | 'hidden' = 'visible') {
  const target = new EventTarget();
  const doc = {
    visibilityState: initial as 'visible' | 'hidden',
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const setVisibility = (v: 'visible' | 'hidden') => {
    doc.visibilityState = v;
    target.dispatchEvent(new Event('visibilitychange'));
  };
  return { doc: doc as VisibilityDoc, setVisibility };
}

describe('createVisibilityAwarePoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls the task on every interval while shouldPoll() is true', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { doc } = fakeDoc();
    const p = createVisibilityAwarePoller({ intervalMs: 5_000, task, shouldPoll: () => true, doc });
    expect(task).not.toHaveBeenCalled(); // no immediate fire: the caller loaded on mount
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('skips ticks while shouldPoll() is false (no OPEN in-session tracker)', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    let open = false;
    const p = createVisibilityAwarePoller({
      intervalMs: 5_000,
      task,
      shouldPoll: () => open,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(task).not.toHaveBeenCalled();
    open = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('stops for good on stop() (unmount)', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const p = createVisibilityAwarePoller({
      intervalMs: 5_000,
      task,
      shouldPoll: () => true,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    p.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and catches up immediately on return', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { doc, setVisibility } = fakeDoc();
    const p = createVisibilityAwarePoller({ intervalMs: 5_000, task, shouldPoll: () => true, doc });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('does not catch up on return when shouldPoll() is false', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { doc, setVisibility } = fakeDoc();
    const p = createVisibilityAwarePoller({ intervalMs: 5_000, task, shouldPoll: () => false, doc });
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(task).not.toHaveBeenCalled();
    p.stop();
  });

  it('does not resume on visibility return after stop()', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { doc, setVisibility } = fakeDoc();
    const p = createVisibilityAwarePoller({ intervalMs: 5_000, task, shouldPoll: () => true, doc });
    setVisibility('hidden');
    p.stop();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(task).not.toHaveBeenCalled();
  });

  it('never overlaps: a slow task is not re-entered by the next tick', async () => {
    let resolve!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const p = createVisibilityAwarePoller({
      intervalMs: 5_000,
      task,
      shouldPoll: () => true,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(15_000); // three more ticks while the first is in flight
    expect(task).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('survives a rejected task and keeps polling', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const p = createVisibilityAwarePoller({
      intervalMs: 5_000,
      task,
      shouldPoll: () => true,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('works without a document (SSR / node) as a plain interval', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const p = createVisibilityAwarePoller({ intervalMs: 5_000, task, shouldPoll: () => true, doc: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
    p.stop();
  });
});

describe('createVisibilityAwarePoller refreshOnVisible:false', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('still pauses while hidden but does not fire on return (expensive tasks)', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { doc, setVisibility } = fakeDoc();
    const p = createVisibilityAwarePoller({
      intervalMs: 5_000,
      task,
      shouldPoll: () => true,
      doc,
      refreshOnVisible: false,
    });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
