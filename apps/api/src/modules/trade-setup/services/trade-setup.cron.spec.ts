import { BOOT_CATCH_UP_DELAY_MS, inNightWindow, TradeSetupCron } from './trade-setup.cron';

const ist = (s: string) => new Date(`${s}+05:30`);

describe('inNightWindow (23:50 → 08:50 IST)', () => {
  it.each([
    ['2026-10-22T23:51:00', true],   // the 2026-10-22 deploy restarted the API here
    ['2026-10-23T01:04:00', true],
    ['2026-10-23T08:49:00', true],
    ['2026-10-23T08:50:00', false],  // the morning cron owns it from here
    ['2026-10-23T15:40:00', false],
    ['2026-10-22T23:49:00', false],  // before the night cron
  ])('%s → %s', (t, want) => {
    expect(inNightWindow(ist(t))).toBe(want);
  });
});

describe('TradeSetupCron boot catch-up', () => {
  afterEach(() => jest.useRealTimers());

  const make = () => {
    const setups = { build: jest.fn().mockResolvedValue({}) };
    const clock = { isTradingDay: () => true };
    return { setups, cron: new TradeSetupCron(setups as never, clock as never) };
  };

  it('builds once after the delay when booted inside the night window', async () => {
    jest.useFakeTimers({ now: ist('2026-10-22T23:51:00') });
    const { setups, cron } = make();
    cron.onApplicationBootstrap();
    expect(setups.build).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(BOOT_CATCH_UP_DELAY_MS);
    expect(setups.build).toHaveBeenCalledTimes(1);
  });

  it('does nothing when booted during the day', async () => {
    jest.useFakeTimers({ now: ist('2026-10-23T15:40:00') });
    const { setups, cron } = make();
    cron.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(BOOT_CATCH_UP_DELAY_MS * 2);
    expect(setups.build).not.toHaveBeenCalled();
  });
});
