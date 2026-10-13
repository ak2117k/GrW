import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isQuietDenial, startAiExitPolling, AI_EXITS_POLL_MS } from './useAiExits';
import type { VisibilityDoc } from '@/services/interval-poller';

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
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('isQuietDenial', () => {
  it('403 and 404 are permanent quiet denials; others are transient', () => {
    expect(isQuietDenial(httpErr(403))).toBe(true);
    expect(isQuietDenial(httpErr(404))).toBe(true);
    expect(isQuietDenial(httpErr(500))).toBe(false);
    expect(isQuietDenial(new Error('network'))).toBe(false);
    expect(isQuietDenial(undefined)).toBe(false);
  });
});

describe('startAiExitPolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls every 10 s', () => {
    expect(AI_EXITS_POLL_MS).toBe(10_000);
  });

  it('loads at once, then on every interval while visible', async () => {
    const get = vi.fn().mockResolvedValue([{ id: 'a' }]);
    const onData = vi.fn();
    const p = startAiExitPolling({ get, onData, doc: fakeDoc().doc, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith([{ id: 'a' }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(get).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('does not poll while the tab is hidden', async () => {
    const get = vi.fn().mockResolvedValue([]);
    const { doc, setVisibility } = fakeDoc('visible');
    const p = startAiExitPolling({ get, onData: vi.fn(), doc, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('a 403 empties the list and stops polling for good', async () => {
    const get = vi.fn().mockRejectedValue(httpErr(403));
    const onData = vi.fn();
    const { doc, setVisibility } = fakeDoc();
    const p = startAiExitPolling({ get, onData, doc, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith([]);
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('a transient failure keeps the last rows and retries next tick', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce([{ id: 'a' }])
      .mockRejectedValueOnce(httpErr(502))
      .mockResolvedValue([{ id: 'b' }]);
    const onData = vi.fn();
    const p = startAiExitPolling({ get, onData, doc: fakeDoc().doc, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onData).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onData).toHaveBeenLastCalledWith([{ id: 'b' }]);
    p.stop();
  });

  it('a non-array payload is treated as empty', async () => {
    const onData = vi.fn();
    const p = startAiExitPolling({ get: vi.fn().mockResolvedValue({ nope: 1 }), onData, doc: fakeDoc().doc });
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith([]);
    p.stop();
  });

  it('delivers nothing after stop()', async () => {
    let resolve!: (v: unknown) => void;
    const get = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
    const onData = vi.fn();
    const p = startAiExitPolling({ get, onData, doc: fakeDoc().doc });
    p.stop();
    resolve([{ id: 'late' }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onData).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
