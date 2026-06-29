import {
  MARKET_CLOSE_HOUR,
  MARKET_CLOSE_MINUTE,
  MCX_CLOSE_HOUR,
  MCX_CLOSE_MINUTE,
} from '@td/shared/constants';

/**
 * Floor on signal lifetime — even a signal created near session close
 * should stay actionable long enough for a manual trader to react. We
 * always give the trader at least this much window.
 */
export const MIN_SIGNAL_TTL_MINUTES = 120;

/**
 * Hard cap on signal lifetime. If the session-end calculation would
 * push expiry beyond this, we clamp. Prevents weekend-generated signals
 * from staying "active" through Monday.
 */
export const MAX_SIGNAL_TTL_HOURS = 14;

/**
 * Compute when a signal should expire based on its exchange's session
 * close. NSE/BSE: 15:30 IST. MCX: 23:30 IST. Signals get a 2h floor
 * so end-of-session generation still gives the trader a window. If the
 * session is already closed for today (e.g. scan-now after hours),
 * defaults to MAX_SIGNAL_TTL_HOURS.
 *
 * Shared between SignalGeneratorService.saveSignal and the
 * UniverseScannerWorker so every signal-creation path gets a non-null
 * expiry. Missing expiry was the root cause of the /signals page
 * accumulating weeks of stale rows — the 5-min cron skips rows with
 * expiresAt=null.
 */
export function computeExpiry(exchange: string, now: Date = new Date()): Date {
  const isMcx = exchange === 'MCX';
  const closeHour = isMcx ? MCX_CLOSE_HOUR : MARKET_CLOSE_HOUR;
  const closeMinute = isMcx ? MCX_CLOSE_MINUTE : MARKET_CLOSE_MINUTE;

  // IST is UTC+5:30. Build today's session-close in UTC.
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istClose = new Date(
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      closeHour,
      closeMinute,
      0,
      0,
    ),
  );
  const utcClose = new Date(istClose.getTime() - istOffsetMs);

  const floor = new Date(now.getTime() + MIN_SIGNAL_TTL_MINUTES * 60 * 1000);
  const cap = new Date(now.getTime() + MAX_SIGNAL_TTL_HOURS * 60 * 60 * 1000);

  // Take the later of (session-close, floor) so end-of-day signals get
  // their 2h window. Then clamp to the hard cap so off-hours signals
  // (weekends, late-night) don't live forever.
  const candidate = utcClose.getTime() > floor.getTime() ? utcClose : floor;
  return candidate.getTime() > cap.getTime() ? cap : candidate;
}
