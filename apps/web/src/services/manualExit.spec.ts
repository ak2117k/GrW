import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  canExitTracker,
  exitConfirmText,
  exitErrorText,
  exitStatusLine,
  exitTone,
  isTerminalExitStatus,
  startExitStatusPolling,
  MANUAL_EXIT_POLL_MS,
} from './manualExit';
import type { AiExitRow } from '@/hooks/useAiExits';

const T = { status: 'OPEN' as const, kind: 'POSITION' as const, exchange: 'MCX', qty: 100, symbol: 'CRUDEOIL15OCT268950CE' };
const row = (status: AiExitRow['status'], over: Partial<AiExitRow> = {}): AiExitRow => ({
  id: 'e1', verdictId: 'man_t1_1', trackerId: 't1', symbol: T.symbol, exchange: 'MCX', side: 'SELL', quantity: 100,
  productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null, mode: 'live', status, reason: null,
  sessionSource: 'user-feed', brokerOrderId: null, brokerMessage: null, orderStatus: null, marketOrderId: null,
  verdictReason: 'MANUAL: owner Exit now (Portfolio)', trigger: 'MANUAL', createdAt: '2026-10-13T10:00:00Z',
  updatedAt: '2026-10-13T10:00:01Z', ...over,
});

describe('canExitTracker', () => {
  it('ADMIN on an OPEN NFO/BFO/MCX POSITION only', () => {
    expect(canExitTracker(T, 'ADMIN')).toBe(true);
    expect(canExitTracker({ ...T, exchange: 'nfo' }, 'ADMIN')).toBe(true);
    expect(canExitTracker({ ...T, exchange: 'BFO' }, 'ADMIN')).toBe(true);
    expect(canExitTracker(T, 'USER')).toBe(false);
    expect(canExitTracker(T, undefined)).toBe(false);
    expect(canExitTracker({ ...T, status: 'CLOSED' }, 'ADMIN')).toBe(false);
    expect(canExitTracker({ ...T, kind: 'HOLDING' }, 'ADMIN')).toBe(false);
    expect(canExitTracker({ ...T, exchange: 'NSE' }, 'ADMIN')).toBe(false);
  });

  it('hidden for a zero-qty tracker (the closing side is unknown: the broker may make it a BUY)', () => {
    expect(canExitTracker({ ...T, qty: 0 }, 'ADMIN')).toBe(false);
    expect(canExitTracker({ ...T, qty: -50 }, 'ADMIN')).toBe(true);
  });
});

describe('exitConfirmText', () => {
  it('a long is sold, a short is bought back, at MARKET', () => {
    expect(exitConfirmText(T)).toBe('Sell 100 CRUDEOIL15OCT268950CE at MARKET?');
    expect(exitConfirmText({ ...T, qty: -75, symbol: 'NIFTY14OCT2625000PE' })).toBe('Buy 75 NIFTY14OCT2625000PE at MARKET?');
  });
});

describe('status helpers', () => {
  it('only CLAIMED / PLACED are still working', () => {
    expect(isTerminalExitStatus('CLAIMED')).toBe(false);
    expect(isTerminalExitStatus('PLACED')).toBe(false);
    for (const s of ['FILLED', 'REJECTED', 'FAILED', 'SKIPPED', 'DRY_RUN'] as const) expect(isTerminalExitStatus(s)).toBe(true);
  });

  it('status line carries reason, order id and the broker message on failure', () => {
    expect(exitStatusLine(row('CLAIMED'))).toBe('SENDING');
    expect(exitStatusLine(row('FILLED', { brokerOrderId: 'O1' }))).toBe('FILLED · order O1');
    expect(exitStatusLine(row('SKIPPED', { reason: 'OPEN_ORDER_EXISTS' }))).toBe('SKIPPED: OPEN_ORDER_EXISTS');
    expect(exitStatusLine(row('REJECTED', { reason: 'BROKER_REJECTED', brokerOrderId: 'O2', brokerMessage: 'RMS: margin' })))
      .toBe('REJECTED: BROKER_REJECTED · order O2 · RMS: margin');
    expect(exitTone('FILLED')).toBe('good');
    expect(exitTone('PLACED')).toBe('working');
    expect(exitTone('FAILED')).toBe('bad');
    expect(exitTone('SKIPPED')).toBe('muted');
  });

  it('error text prefers the API reason', () => {
    const err = (status: number, message?: unknown) => ({ response: { status, data: message === undefined ? {} : { message } } });
    expect(exitErrorText(err(422, 'QTY_UNIT_UNCONFIGURED:MCX: set …'))).toBe('QTY_UNIT_UNCONFIGURED:MCX: set …');
    expect(exitErrorText(err(403))).toBe('Manual exit is not enabled for this account');
    expect(exitErrorText(err(404))).toBe('Tracker not found');
    expect(exitErrorText(new Error('network'))).toMatch(/check the broker/);
  });
});

describe('startExitStatusPolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls every 3 s until the attempt is terminal, then stops', async () => {
    expect(MANUAL_EXIT_POLL_MS).toBe(3_000);
    const get = vi.fn()
      .mockResolvedValueOnce([row('CLAIMED')])
      .mockResolvedValueOnce([row('PLACED', { brokerOrderId: 'O1' })])
      .mockResolvedValue([row('FILLED', { brokerOrderId: 'O1' }), row('SKIPPED', { id: 'other' })]);
    const onRow = vi.fn();
    const onDone = vi.fn();
    startExitStatusPolling({ executionId: 'e1', get, onRow, onDone, doc: null });
    await vi.advanceTimersByTimeAsync(3_000 * 5);
    expect(get).toHaveBeenCalledTimes(3);
    expect(onRow.mock.calls.map((c) => c[0].status)).toEqual(['CLAIMED', 'PLACED', 'FILLED']);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxMs (a resting PLACED order) and ignores failed polls', async () => {
    let t = 0;
    const get = vi.fn().mockRejectedValueOnce(new Error('cold')).mockResolvedValue([row('PLACED')]);
    const onDone = vi.fn();
    startExitStatusPolling({ executionId: 'e1', get, onRow: vi.fn(), onDone, doc: null, now: () => t, maxMs: 9_000 });
    for (let i = 0; i < 6; i++) { t += 3_000; await vi.advanceTimersByTimeAsync(3_000); }
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('delivers nothing after stop()', async () => {
    const get = vi.fn().mockResolvedValue([row('PLACED')]);
    const onRow = vi.fn();
    const p = startExitStatusPolling({ executionId: 'e1', get, onRow, doc: null });
    p.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(get).not.toHaveBeenCalled();
    expect(onRow).not.toHaveBeenCalled();
  });
});
