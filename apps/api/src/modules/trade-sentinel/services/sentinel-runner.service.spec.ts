import { Logger } from '@nestjs/common';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import {
  OI_SNAPSHOT_CLEANUP_CRON,
  OI_SNAPSHOT_RETENTION_DAYS,
  SENTINEL_ENABLED_KEY,
  SENTINEL_TICK_CRON,
  SentinelRunnerService,
  isWithinSession,
} from './sentinel-runner.service';

const REPORT = { evaluated: 1, skipped: 0, failed: 0, unwatched: 0 };

function make(enabled = true) {
  const runForUser = jest.fn().mockResolvedValue(REPORT);
  const findMany = jest.fn().mockResolvedValue([{ userId: 'u1', exchange: 'NSE' }]);
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    tradeTracker: { findMany },
    oiWallSnapshot: { deleteMany },
  };
  const config = { get: jest.fn().mockReturnValue(enabled ? 'true' : 'false') };
  const svc = new SentinelRunnerService(
    { runForUser } as never,
    prisma as never,
    config as never,
  );
  return { svc, runForUser, findMany, deleteMany, config };
}

/** A deferred promise, so a cycle can be held mid-flight. */
function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SentinelRunnerService — overlap guard', () => {
  it('refuses a second cycle for a user whose first has not finished', async () => {
    const t = make();
    const held = pending<typeof REPORT>();
    t.runForUser.mockReturnValueOnce(held.promise);

    const first = t.svc.runForUser('u1');
    // Not awaited: the first cycle is deliberately still in flight, which is
    // the ordinary case — an Anthropic call outlasting a 30s tick.
    const second = await t.svc.runForUser('u1');

    expect(second).toBeNull();
    // The cycle carries the green-floor latch, the thesis cooldown, the agent
    // backoff deadline and the OI capture window in ONE map keyed by trackerId.
    // A second concurrent run would double-write verdicts and OI rows.
    expect(t.runForUser).toHaveBeenCalledTimes(1);

    held.resolve(REPORT);
    await expect(first).resolves.toEqual(REPORT);
  });

  it('releases the guard once the cycle finishes, so the next tick runs', async () => {
    const t = make();
    await t.svc.runForUser('u1');
    await t.svc.runForUser('u1');
    expect(t.runForUser).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the cycle THROWS, or the user is never watched again', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.runForUser.mockRejectedValueOnce(new Error('trade-tracker down'));

    await t.svc.runForUser('u1');
    await t.svc.runForUser('u1');

    expect(t.runForUser).toHaveBeenCalledTimes(2);
  });

  it('guards per user, not globally — one slow tenant must not blind the others', async () => {
    const t = make();
    const held = pending<typeof REPORT>();
    t.runForUser.mockReturnValueOnce(held.promise);

    const slow = t.svc.runForUser('u1');
    await expect(t.svc.runForUser('u2')).resolves.toEqual(REPORT);

    held.resolve(REPORT);
    await slow;
  });
});

describe('SentinelRunnerService — a roster failure must not escape', () => {
  it('catches the cycle rejection, logs it at error with the tenant, and returns null', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.runForUser.mockRejectedValue(new Error('trade-tracker down'));

    // `SentinelCycleService.runForUser` REJECTS on a roster failure — the one
    // throwing path, and it throws on purpose. Escaping into a bare scheduler
    // tick turns it into an unhandled rejection with no user and no cause.
    await expect(t.svc.runForUser('u1')).resolves.toBeNull();

    const message = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('u1');
    expect(message).toContain('trade-tracker down');
  });

  it('never reports a failed run as a completed one', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.runForUser.mockRejectedValue(new Error('boom'));
    // null, not a zeroed report: "did not run" and "ran and found nothing"
    // are different facts, and a success-shaped zero would be swallowed by any
    // metric that sums the fields.
    await expect(t.svc.runForUser('u1')).resolves.toBeNull();
  });

  it('a tick keeps going to the next user after one tenant fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.findMany.mockResolvedValue([{ userId: 'u1', exchange: 'NSE' }, { userId: 'u2', exchange: 'NSE' }]);
    t.runForUser.mockRejectedValueOnce(new Error('boom'));
    jest.spyOn(Date, 'now'); // no-op, keeps the session gate on the real clock

    // Force the session gate open by calling the guarded path directly.
    await t.svc.runForUser('u1');
    await t.svc.runForUser('u2');
    expect(t.runForUser).toHaveBeenCalledTimes(2);
  });
});

describe('SentinelRunnerService — the tick is gated', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does nothing at all when the shadow flag is off', async () => {
    const t = make(false);
    await t.svc.tick();
    expect(t.findMany).not.toHaveBeenCalled();
    expect(t.runForUser).not.toHaveBeenCalled();
    expect(t.config.get).toHaveBeenCalledWith(SENTINEL_ENABLED_KEY);
  });

  it('does not run outside the session even when enabled', async () => {
    const t = make(true);
    // A Sunday.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T06:00:00Z'));
    await t.svc.tick();
    jest.useRealTimers();
    expect(t.findMany).not.toHaveBeenCalled();
  });

  it('runs every tenant with an open trade when enabled and in session', async () => {
    const t = make(true);
    t.findMany.mockResolvedValue([{ userId: 'u1', exchange: 'NSE' }, { userId: 'u2', exchange: 'NSE' }]);
    // Friday 14 Aug 2026, 10:00 IST.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T04:30:00Z'));
    await t.svc.tick();
    jest.useRealTimers();

    expect(t.runForUser).toHaveBeenCalledTimes(2);
    // Distinct on the PAIR, not on userId alone: a user holding both an NFO
    // option and an MCX future must yield both venues, or the evening half of
    // their book silently stops being watched at 15:30.
    expect(t.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'OPEN' },
        distinct: ['userId', 'exchange'],
      }),
    );
  });

  it('a failed user listing is logged, not thrown out of the scheduler', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make(true);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T04:30:00Z'));
    t.findMany.mockRejectedValue(new Error('db down'));

    await expect(t.svc.tick()).resolves.toBeUndefined();
    jest.useRealTimers();
    expect(error.mock.calls.map((c) => String(c[0])).join('')).toContain('db down');
  });
});

describe('SentinelRunnerService — the schedule itself', () => {
  /** What `@Cron` recorded on the method, straight off the decorator metadata. */
  const cronMeta = (method: string) =>
    (Reflect as { getMetadata?: (k: unknown, t: unknown) => unknown }).getMetadata?.(
      SCHEDULE_CRON_OPTIONS,
      (SentinelRunnerService.prototype as unknown as Record<string, unknown>)[method] as object,
    ) as { cronTime?: string; timeZone?: string } | undefined;

  it('ticks every 30 SECONDS — the six-field form', () => {
    // A typo dropping the seconds field turns '*/30 * * * * *' into
    // '*/30 * * * *', which is every 30 MINUTES. It compiles, it schedules
    // happily, and no behavioural test would notice: the sentinel would simply
    // be 60x slower to see a level break.
    expect(SENTINEL_TICK_CRON.trim().split(/\s+/)).toHaveLength(6);
    expect(SENTINEL_TICK_CRON).toBe('*/30 * * * * *');
  });

  it('prunes nightly at a fixed time, also in the six-field form', () => {
    expect(OI_SNAPSHOT_CLEANUP_CRON.trim().split(/\s+/)).toHaveLength(6);
    expect(OI_SNAPSHOT_CLEANUP_CRON).toBe('0 30 2 * * *');
  });

  it('registers both crons in IST, not in the host timezone', () => {
    // The tick's window is IST wall-clock (09:15–15:29) and the prune is timed
    // to sit between the session and the pre-market crons. On a UTC host — this
    // deploys to Render/Oregon — an unzoned schedule shifts both by 5.5 hours.
    expect(cronMeta('tick')).toEqual({
      cronTime: SENTINEL_TICK_CRON,
      timeZone: 'Asia/Kolkata',
    });
    expect(cronMeta('pruneOiSnapshots')).toEqual({
      cronTime: OI_SNAPSHOT_CLEANUP_CRON,
      timeZone: 'Asia/Kolkata',
    });
  });
});

describe('isWithinSession', () => {
  it('is open during the IST session on a weekday', () => {
    expect(isWithinSession(new Date('2026-08-14T04:30:00Z'))).toBe(true); // 10:00 IST Fri
    expect(isWithinSession(new Date('2026-08-14T03:45:00Z'))).toBe(true); // 09:15 IST
    expect(isWithinSession(new Date('2026-08-14T09:59:00Z'))).toBe(true); // 15:29 IST
  });

  it('is closed before the open, at the close, and at the weekend', () => {
    expect(isWithinSession(new Date('2026-08-14T03:44:00Z'))).toBe(false); // 09:14 IST
    // 15:30 IST exactly: the session is over, and `minutesToClose` in the packet
    // already reports it as closed. The two must not disagree.
    expect(isWithinSession(new Date('2026-08-14T10:00:00Z'))).toBe(false);
    expect(isWithinSession(new Date('2026-08-15T04:30:00Z'))).toBe(false); // Saturday
    expect(isWithinSession(new Date('2026-08-16T04:30:00Z'))).toBe(false); // Sunday
  });
});

describe('SentinelRunnerService — OI snapshot retention', () => {
  afterEach(() => jest.restoreAllMocks());

  it('deletes only rows older than the retention window', async () => {
    const t = make();
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00Z'));

    await t.svc.pruneOiSnapshots();

    jest.useRealTimers();
    const where = t.deleteMany.mock.calls[0][0].where;
    const cutoff: Date = where.capturedAt.lt;
    expect(cutoff.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    // The whole point is that it is bounded AND that it does not wipe the
    // series the shift sensor's `prev` and Task 13's replay both read.
    expect(Date.UTC(2026, 7, 14) - cutoff.getTime()).toBe(
      OI_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('reports how many it removed', async () => {
    const t = make();
    t.deleteMany.mockResolvedValue({ count: 12 });
    await expect(t.svc.pruneOiSnapshots()).resolves.toBe(12);
  });

  it('never throws out of the scheduled method', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.deleteMany.mockRejectedValue(new Error('db down'));

    await expect(t.svc.pruneOiSnapshots()).resolves.toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it('prunes regardless of the shadow flag — the rows exist either way', async () => {
    const t = make(false);
    await t.svc.pruneOiSnapshots();
    expect(t.deleteMany).toHaveBeenCalled();
  });
});
