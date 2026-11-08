import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SELF_REVIEW_CATCHUP_CRON, SELF_REVIEW_CRON, SelfReviewCron } from './self-review.cron';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function make() {
  const runner = { run: jest.fn(async () => ({ started: true })) };
  return { runner, cron: new SelfReviewCron(runner as never, clock) };
}

describe('SelfReviewCron', () => {
  it('runs at 00:30 IST Tue-Sat (after the MCX close and the 23:45 daily bars); the catch-up stays at 09:00', () => {
    expect(SELF_REVIEW_CRON).toBe('0 30 0 * * 2-6');
    expect(SELF_REVIEW_CATCHUP_CRON).toBe('0 0 9 * * 1-5');
  });

  it('00:30 Saturday reviews Friday: the gate asks about the session that just ended, not the new date', async () => {
    const { runner, cron } = make();
    const now = new Date('2026-11-06T19:00:00Z'); // Sat 7 Nov 00:30 IST
    await cron.fire('cron', now);
    expect(runner.run).toHaveBeenCalledWith(now, 'cron');
  });

  it('00:30 after an NSE holiday does nothing', async () => {
    const { runner, cron } = make();
    await cron.fire('cron', new Date('2026-10-20T19:00:00Z')); // Wed 21 Oct 00:30 IST, Tue 20 Oct = Dussehra
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('the 09:00 catch-up is still gated on its own day', async () => {
    const weekday = make();
    await weekday.cron.fire('catch-up', new Date('2026-11-09T03:30:00Z')); // Mon 09:00 IST
    expect(weekday.runner.run).toHaveBeenCalledTimes(1);
    const saturday = make();
    await saturday.cron.fire('catch-up', new Date('2026-11-07T03:30:00Z')); // Sat 09:00 IST
    expect(saturday.runner.run).not.toHaveBeenCalled();
  });
});
