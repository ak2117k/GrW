import { WarnLimiter } from './warn-limiter';

describe('WarnLimiter', () => {
  it('logs the first occurrence, holds identical repeats for the window, then logs with a suppressed count', () => {
    let t = 0;
    const l = new WarnLimiter(60 * 60_000, () => t);
    const log = { warn: jest.fn() };
    expect(l.warn(log, 'k', 'no fresh price')).toBe(true);
    for (let i = 1; i <= 100; i++) {
      t = i * 60_000 - 1; // every cycle within the hour
      if (t < 60 * 60_000) l.warn(log, 'k', 'no fresh price');
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    t = 60 * 60_000;
    expect(l.warn(log, 'k', 'no fresh price')).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toMatch(/^no fresh price \(\d+ identical warnings suppressed in the last 60 min\)$/);
  });

  it('keys are independent — a different entity or a different failure still logs', () => {
    const l = new WarnLimiter(60 * 60_000, () => 0);
    const log = { warn: jest.fn() };
    l.warn(log, 'a', 'x');
    l.warn(log, 'b', 'x');
    l.warn(log, 'a', 'x');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('message() returns null while rate-limited', () => {
    const l = new WarnLimiter(1000, () => 0);
    expect(l.message('k', 'hi')).toBe('hi');
    expect(l.message('k', 'hi')).toBeNull();
  });
});
