import { Logger } from '@nestjs/common';
import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SELF_REVIEW_CATCHUP_CRON, SELF_REVIEW_CRON, SELF_REVIEW_MISSED_MOVES_CRON, SelfReviewCron } from './self-review.cron';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function make() {
  const runner = { run: jest.fn(async () => ({ started: true })) };
  return { runner, cron: new SelfReviewCron(runner as never, clock) };
}

describe('SelfReviewCron', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs at 00:30 IST Tue-Sat (after the MCX close and the 23:45 daily bars); the catch-up stays at 09:00', () => {
    expect(SELF_REVIEW_CRON).toBe('0 30 0 * * 2-6');
    expect(SELF_REVIEW_CATCHUP_CRON).toBe('0 0 9 * * 1-5');
  });

  it('runs again at 02:30 IST Tue-Sat, once the 01:56 stock book has the closes the missed-move review needs', async () => {
    expect(SELF_REVIEW_MISSED_MOVES_CRON).toBe('0 30 2 * * 2-6');
    const { runner, cron } = make();
    const now = new Date('2026-11-06T21:00:00Z'); // Sat 7 Nov 02:30 IST
    await cron.onMissedMoves(now);
    expect(runner.run).toHaveBeenCalledWith(now, 'missed-moves');
  });

  it('00:30 Saturday reviews Friday: the gate asks about the session that just ended, not the new date', async () => {
    const { runner, cron } = make();
    const now = new Date('2026-11-06T19:00:00Z'); // Sat 7 Nov 00:30 IST
    await cron.fire('cron', now);
    expect(runner.run).toHaveBeenCalledWith(now, 'cron');
  });

  it('00:30 after an NSE holiday with an MCX evening session reviews it (2026-11-10, Diwali Balipratipada)', async () => {
    const { runner, cron } = make();
    const now = new Date('2026-11-10T19:00:00Z'); // Wed 11 Nov 00:30 IST
    await cron.fire('cron', now);
    expect(runner.run).toHaveBeenCalledWith(now, 'cron');
    const dussehra = make();
    await dussehra.cron.fire('cron', new Date('2026-10-20T19:00:00Z')); // Wed 21 Oct 00:30 IST, Tue 20 Oct = Dussehra
    expect(dussehra.runner.run).toHaveBeenCalledTimes(1);
  });

  it('a day both NSE and MCX are shut is skipped, with one log line saying why', async () => {
    const shut = new SessionClock({ holidays: MARKET_HOLIDAYS, mcxHolidays: { 2026: [{ date: '2026-12-25', name: 'Christmas', session: 'CLOSED' }] } });
    const runner = { run: jest.fn(async () => ({ started: true })) };
    const cron = new SelfReviewCron(runner as never, shut);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await cron.fire('cron', new Date('2026-12-25T19:00:00Z')); // Sat 26 Dec 00:30 IST, Fri 25 Dec shut on both
    expect(runner.run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[self-review] cron skipped: 2026-12-25 not a trading day on NSE or MCX');
  });

  it('a weekend is skipped with a log line', async () => {
    const { runner, cron } = make();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await cron.fire('catch-up', new Date('2026-11-07T03:30:00Z')); // Sat 09:00 IST
    expect(runner.run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[self-review] catch-up skipped: 2026-11-07 not a trading day on NSE or MCX');
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
