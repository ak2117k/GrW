/**
 * The portfolio-review monthly quota hook (owner 2026-11-02: "free once per month per user, then a
 * subscription"). The subscription is NEXT; for now this only COUNTS — `allowed` is always true and
 * nobody is blocked. When it is enforced, flip QUOTA_ENFORCED and gate POST /run on `allowed`.
 */
import { istMonth } from './symbols';
import type { ReviewQuota } from './types';

export const FREE_REVIEWS_PER_MONTH = 1;
export const QUOTA_ENFORCED = false;

/** The UTC instant the IST calendar month containing `now` began. */
export function istMonthStart(now: Date): Date {
  return new Date(`${istMonth(now)}-01T00:00:00+05:30`);
}

/** Quota from the number of runs started (RUNNING or DONE) this IST month. Pure. */
export function reviewQuotaFrom(usedThisMonth: number, now: Date): ReviewQuota {
  const used = Math.max(0, Math.floor(usedThisMonth));
  const over = used >= FREE_REVIEWS_PER_MONTH;
  return {
    usedThisMonth: used,
    freeLimit: FREE_REVIEWS_PER_MONTH,
    allowed: QUOTA_ENFORCED ? !over : true,
    enforced: QUOTA_ENFORCED,
    periodStart: istMonth(now),
    note: `${FREE_REVIEWS_PER_MONTH} free review per month (not enforced yet) — ${used} used this month${over ? '; further runs will need a subscription once it is switched on' : ''}.`,
  };
}
