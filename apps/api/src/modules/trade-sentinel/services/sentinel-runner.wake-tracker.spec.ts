import { Logger } from '@nestjs/common';
import { SentinelRunnerService } from './sentinel-runner.service';

/** Trade agent exit authority: SentinelRunnerService.wakeTracker (TrackerWakePort). */
const REPORT = { evaluated: 0, skipped: 1, failed: 0, unwatched: 0 };
const OPEN = new Date('2026-08-14T04:30:00Z'); // Fri 10:00 IST
const flush = () => new Promise((r) => setImmediate(r));

function make(opts: { enabled?: boolean; exchange?: string | null } = {}) {
  const startForUser = jest.fn(async () => ({ report: REPORT, pending: 0, settled: Promise.resolve(REPORT) }));
  const markAlarmWake = jest.fn();
  const findUnique = jest.fn(async () => (opts.exchange === null ? null : { exchange: opts.exchange ?? 'NFO' }));
  const prisma = { tradeTracker: { findMany: jest.fn().mockResolvedValue([]), findUnique } };
  const config = { get: jest.fn().mockReturnValue(opts.enabled === false ? 'false' : 'true') };
  const svc = new SentinelRunnerService({ startForUser, markAlarmWake } as never, prisma as never, config as never);
  return { svc, startForUser, markAlarmWake, findUnique };
}

beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('SentinelRunnerService.wakeTracker', () => {
  it('marks the tracker and runs the user\'s ordinary pass', async () => {
    const t = make();
    t.svc.wakeTracker('u1', 't1', 'FLOOR alarm raised', OPEN);
    await flush();
    expect(t.markAlarmWake).toHaveBeenCalledWith('t1', 'FLOOR alarm raised');
    expect(t.startForUser).toHaveBeenCalledWith('u1');
  });

  it('at most one wake per tracker per TRACKER_WAKE_MIN_GAP_MS', async () => {
    const t = make();
    t.svc.wakeTracker('u1', 't1', 'a', OPEN);
    await flush();
    t.svc.wakeTracker('u1', 't1', 'b', new Date(OPEN.getTime() + 5_000));
    await flush();
    expect(t.startForUser).toHaveBeenCalledTimes(1);
    t.svc.wakeTracker('u1', 't1', 'c', new Date(OPEN.getTime() + 21_000));
    await flush();
    expect(t.startForUser).toHaveBeenCalledTimes(2);
  });

  it('the tracker\'s venue is closed (NFO at 19:00 IST) → nothing', async () => {
    const t = make();
    t.svc.wakeTracker('u1', 't1', 'x', new Date('2026-08-14T13:30:00Z'));
    await flush();
    expect(t.startForUser).not.toHaveBeenCalled();
  });

  it('unknown tracker → nothing; disabled sentinel → nothing (not even a read)', async () => {
    const t = make({ exchange: null });
    t.svc.wakeTracker('u1', 't1', 'x', OPEN);
    await flush();
    expect(t.startForUser).not.toHaveBeenCalled();
    const off = make({ enabled: false });
    off.svc.wakeTracker('u1', 't1', 'x', OPEN);
    await flush();
    expect(off.findUnique).not.toHaveBeenCalled();
  });

  it('the user\'s pass already in flight → no second pass (the next tick reads the alarm anyway)', async () => {
    const t = make();
    let release!: () => void;
    t.startForUser.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ report: REPORT, pending: 0, settled: Promise.resolve(REPORT) }))),
    );
    const first = t.svc.runForUser('u1');
    t.svc.wakeTracker('u1', 't1', 'x', OPEN);
    await flush();
    expect(t.startForUser).toHaveBeenCalledTimes(1);
    expect(t.markAlarmWake).not.toHaveBeenCalled();
    release();
    await first;
  });
});
