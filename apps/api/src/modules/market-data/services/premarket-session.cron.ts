import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AngelOneAuthService } from './angel-one-auth.service';

/**
 * Pre-market Angel One session guard.
 *
 * Angel's broker-side session dies at the ~6 AM IST pre-market reset. A
 * long-running API then holds a dead token and `getHistoricalData` silently
 * returns [] (blank charts / empty scoring) until the process is restarted.
 *
 * This cron re-logs in at 08:45 IST on weekdays — after the 6 AM reset, before
 * the 09:15 NSE open and the 09:15 level-book seed — so the session is fresh
 * when the market opens. A full `login()` (not refreshToken) is used because
 * the refresh token may also be invalidated by the reset.
 */
@Injectable()
export class PremarketSessionCron {
  private readonly logger = new Logger(PremarketSessionCron.name);

  constructor(private readonly authService: AngelOneAuthService) {}

  @Cron('0 45 8 * * 1-5', {
    timeZone: 'Asia/Kolkata',
    name: 'premarket-angel-relogin',
  })
  async refreshPremarketSession(): Promise<void> {
    await this.reLogin();
  }

  /**
   * Re-establish a fresh Angel session. Never throws: a failed pre-market
   * login must not bubble out of the scheduler. Returns whether it succeeded.
   *
   * Note: `authService.login()` also re-arms the auth service's own ~23h token
   * refresh timer (clearing the old one first), so this re-login realigns that
   * schedule to the fresh session — no duplicate timers result.
   */
  async reLogin(): Promise<boolean> {
    try {
      this.logger.log('Pre-market Angel session refresh: re-logging in…');
      await this.authService.login();
      this.logger.log('Pre-market Angel session refresh: success');
      return true;
    } catch (err) {
      this.logger.error(
        `Pre-market Angel session refresh failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }
}
