import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AngelOneAuthService } from './angel-one-auth.service';
import { UserFeedManager } from './user-feed-manager.service';

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
 *
 * The PER-USER feed sessions die at the same reset and were never refreshed: their
 * sockets keep streaming, so they look live while every REST call on their JWT
 * answers AG8001 "Invalid Token" (prod 2026-10-19: every AI exit failed all day).
 * They are re-logged in right after the shared session — after it, so a shared
 * login on the same account cannot supersede their fresh JWTs.
 */
@Injectable()
export class PremarketSessionCron {
  private readonly logger = new Logger(PremarketSessionCron.name);

  constructor(
    private readonly authService: AngelOneAuthService,
    @Optional() private readonly userFeeds?: UserFeedManager,
  ) {}

  @Cron('0 45 8 * * 1-5', {
    timeZone: 'Asia/Kolkata',
    name: 'premarket-angel-relogin',
  })
  async refreshPremarketSession(): Promise<void> {
    await this.reLogin();
    await this.reLoginUserSessions();
  }

  /** Re-login every registered per-user feed session. Never throws. */
  async reLoginUserSessions(): Promise<void> {
    if (!this.userFeeds) return;
    try {
      const { ok, failed } = await this.userFeeds.reloginAll();
      if (ok + failed > 0) {
        this.logger.log(`Pre-market per-user session refresh: ${ok} re-logged in, ${failed} failed`);
      }
    } catch (err) {
      this.logger.error(
        `Pre-market per-user session refresh failed: ${err instanceof Error ? err.message : err}`,
      );
    }
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
