import {
  TelegramTimeoutError,
  durationText,
  envMinutes,
  istHm,
  recoveredAlertText,
  silentForMs,
  stalledAlertText,
  withTimeout,
} from '../services/telegram-listener-health';

describe('telegram-listener-health', () => {
  afterEach(() => jest.useRealTimers());

  it('withTimeout rejects a promise that never settles, and passes a settled one through', async () => {
    jest.useFakeTimers();
    const hung = withTimeout(new Promise(() => undefined), 30_000, 'poll');
    const check = expect(hung).rejects.toBeInstanceOf(TelegramTimeoutError);
    await jest.advanceTimersByTimeAsync(30_000);
    await check;
    await expect(withTimeout(Promise.resolve(7), 30_000, 'poll')).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('boom')), 30_000, 'poll')).rejects.toThrow('boom');
  });

  it('silence counts from the latest of: last answer, listening start, end of a FLOOD_WAIT pause', () => {
    const now = 1_000_000;
    expect(silentForMs({ now, lastProgressAt: now - 200_000, listeningSince: now - 500_000, floodPauseUntil: 0 })).toBe(200_000);
    expect(silentForMs({ now, lastProgressAt: now - 200_000, listeningSince: now - 10_000, floodPauseUntil: 0 })).toBe(10_000);
    expect(silentForMs({ now, lastProgressAt: null, listeningSince: null, floodPauseUntil: now + 60_000 })).toBe(0);
  });

  it('env minutes fall back on junk', () => {
    expect(envMinutes(undefined, 3)).toBe(3);
    expect(envMinutes('0', 3)).toBe(3);
    expect(envMinutes('abc', 3)).toBe(3);
    expect(envMinutes('10', 3)).toBe(10);
  });

  it('alert texts carry IST time, duration and the caught-up count', () => {
    const down = Date.parse('2026-11-27T21:01:00Z'); // 02:31 IST
    expect(istHm(down)).toBe('02:31 IST');
    expect(durationText(17 * 60_000)).toBe('17 min');
    expect(durationText(18 * 3_600_000 + 5 * 60_000)).toBe('18 h 5 min');
    expect(stalledAlertText({ downSince: down, now: down + 16 * 60_000, state: 'backoff', lastError: 'telegram connect timed out after 90 s' })).toBe(
      'GrW Telegram reader STALLED: no channel post read for 16 min (since 02:31 IST; state backoff, last error telegram connect timed out after 90 s). ' +
        'Restarting the client with backoff; missed posts are caught up when it reconnects.',
    );
    expect(recoveredAlertText({ downSince: down, now: down + 20 * 60_000, caughtUp: 7 })).toContain('after 20 min (down since 02:31 IST). Caught up 7 post(s)');
  });
});
