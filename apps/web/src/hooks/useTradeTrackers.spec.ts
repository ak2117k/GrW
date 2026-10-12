import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startTrackerPolling, TRACKER_POLL_MS, type TradeTracker } from './useTradeTrackers';

/** 2026-10-12 is a Monday. */
const MON_1930 = new Date('2026-10-12T19:30:00+05:30');
const MON_1000 = new Date('2026-10-12T10:00:00+05:30');

function tracker(exchange: string, status: 'OPEN' | 'CLOSED', lastLtp = 100): TradeTracker {
  return {
    id: `${exchange}-${status}-${lastLtp}`,
    symbol: 'X',
    exchange,
    token: '1',
    kind: 'POSITION',
    entryPrice: 90,
    qty: 1,
    entryTime: '2026-10-12T10:00:00.000Z',
    exitPrice: null,
    exitTime: null,
    status,
    holdingHigh: null,
    holdingLow: null,
    dayHigh: null,
    dayLow: null,
    lastLtp,
    pnl: lastLtp - 90,
    pnlPercent: null,
    updatedAt: '2026-10-12T10:00:00.000Z',
  };
}

function fakeDoc() {
  const target = new EventTarget();
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    doc,
    setVisibility(v: 'visible' | 'hidden') {
      doc.visibilityState = v;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('startTrackerPolling (useTradeTrackers live refresh)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls every 5 s', () => {
    expect(TRACKER_POLL_MS).toBe(5_000);
  });

  it('polls the cheap GET while an OPEN MCX tracker is in its evening session, and hands back fresh rows', async () => {
    let rows: TradeTracker[] | null = [tracker('MCX', 'OPEN', 100)];
    const get = vi.fn().mockResolvedValue([tracker('MCX', 'OPEN', 120)]);
    const onData = vi.fn((next: TradeTracker[]) => {
      rows = next;
    });
    const p = startTrackerPolling({
      get,
      getTrackers: () => rows,
      onData,
      isBusy: () => false,
      now: () => MON_1930,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS * 2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenLastCalledWith([tracker('MCX', 'OPEN', 120)]);
    expect(rows?.[0].lastLtp).toBe(120);
    p.stop();
  });

  it('does not poll when the only OPEN trackers are on a shut exchange (NFO at 19:30)', async () => {
    const get = vi.fn().mockResolvedValue([]);
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('NFO', 'OPEN'), tracker('MCX', 'CLOSED')],
      onData: vi.fn(),
      isBusy: () => false,
      now: () => MON_1930,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS * 4);
    expect(get).not.toHaveBeenCalled();
    p.stop();
  });

  it('polls an OPEN NFO tracker during the NSE session', async () => {
    const get = vi.fn().mockResolvedValue([]);
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('NFO', 'OPEN')],
      onData: vi.fn(),
      isBusy: () => false,
      now: () => MON_1000,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('skips a tick while the heavy POST /refresh is in flight', async () => {
    const get = vi.fn().mockResolvedValue([]);
    let busy = true;
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('MCX', 'OPEN')],
      onData: vi.fn(),
      isBusy: () => busy,
      now: () => MON_1930,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS);
    expect(get).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('stops on unmount and never delivers a late response', async () => {
    let resolve!: (v: TradeTracker[]) => void;
    const get = vi.fn(
      () =>
        new Promise<TradeTracker[]>((r) => {
          resolve = r;
        }),
    );
    const onData = vi.fn();
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('MCX', 'OPEN')],
      onData,
      isBusy: () => false,
      now: () => MON_1930,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop(); // unmount while the GET is in flight
    resolve([tracker('MCX', 'OPEN', 999)]);
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS * 4);
    expect(onData).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and refreshes on return', async () => {
    const get = vi.fn().mockResolvedValue([]);
    const { doc, setVisibility } = fakeDoc();
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('MCX', 'OPEN')],
      onData: vi.fn(),
      isBusy: () => false,
      now: () => MON_1930,
      doc,
    });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS * 6);
    expect(get).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('keeps the last good rows when a poll fails', async () => {
    const get = vi.fn().mockRejectedValue(new Error('500'));
    const onData = vi.fn();
    const p = startTrackerPolling({
      get,
      getTrackers: () => [tracker('MCX', 'OPEN')],
      onData,
      isBusy: () => false,
      now: () => MON_1930,
      doc: fakeDoc().doc,
    });
    await vi.advanceTimersByTimeAsync(TRACKER_POLL_MS * 2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(onData).not.toHaveBeenCalled();
    p.stop();
  });
});
