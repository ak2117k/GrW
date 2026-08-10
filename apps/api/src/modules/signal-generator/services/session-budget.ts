/**
 * How far price can still travel before today's close.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §0.3.
 *
 * Why this exists: the chart projected `TGT 24,719.61` from `ENTRY 24,606.80`
 * — 113 NIFTY points — at 12:44 IST on a low-volatility day that had already
 * spent most of its daily range with ~40% of the session left. The projection
 * was structurally correct (there really was a barrier up there) and
 * practically impossible (the day had no such move left in it). Structure says
 * WHERE price would go; it says nothing about whether there is enough day left
 * to get there. This module is the second half of that answer, and like the HTF
 * cap it can only ever take room away.
 *
 * Everything here is pure: no IO, no clock, no DI. `now` is a parameter, which
 * is what makes "12:44 on a Tuesday" and "16:05 after the close" ordinary test
 * cases rather than things that need a fake timer.
 */

/**
 * IST is UTC+5:30. Explicit offset arithmetic, matching the convention in
 * `session-window.ts` — never `toLocaleString`, which depends on the host's
 * timezone database and would make a server in UTC and a laptop in IST disagree
 * about whether the market is open.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

/** Minutes past IST midnight. 09:15 → 555, 15:30 → 930, 23:30 → 1410. */
const minutes = (hours: number, mins: number): number => hours * 60 + mins;

interface SessionHours {
  openMin: number;
  closeMin: number;
  /** For the reason sentence, e.g. "15:30". */
  closeLabel: string;
}

/** NSE/BSE equity, index and F&O: 09:15–15:30 IST. */
const EQUITY_HOURS: SessionHours = {
  openMin: minutes(9, 15),
  closeMin: minutes(15, 30),
  closeLabel: '15:30',
};

/**
 * MCX commodities: 09:00–23:30 IST. The evening session is the point — an MCX
 * budget computed on equity hours would read 0 from 15:30 onward and suppress
 * every commodity projection for the most active half of its day.
 *
 * (MCX shortens to 23:00 in winter. Not modelled: half an hour at the tail of a
 * 14.5-hour session moves the budget by ~3%, well inside the model's own error,
 * and carrying a seasonal calendar here would buy precision we cannot justify.)
 */
const COMMODITY_HOURS: SessionHours = {
  openMin: minutes(9, 0),
  closeMin: minutes(23, 30),
  closeLabel: '23:30',
};

/**
 * A day that has already spent its full ATR does not stop moving — it just
 * stops being LIKELY to add much. This floor keeps the budget from collapsing
 * to zero on a wide-range day, which would suppress every box for the rest of
 * the session; a fully-spent day is still granted a quarter-ATR of further
 * expansion, pro-rated by the time left.
 *
 * A judgement call, not a measured constant, and deliberately small: its job is
 * to stop a hard zero, not to hand back the room the day has already used.
 */
const RESIDUAL_EXPANSION_ATR = 0.25;

export interface SessionBudgetInput {
  /** Caller supplies the clock. This module never calls `new Date()`. */
  now: Date;
  /** 'NSE' | 'BSE' | 'MCX' — hours differ. Anything else uses equity hours. */
  exchange: string;
  /** ATR(14) on the DAILY timeframe. null when unavailable — see `points`. */
  dailyAtr: number | null;
  todayHigh: number | null;
  todayLow: number | null;
}

export interface SessionBudget {
  /**
   * Expected FURTHER travel in points, one direction, from now to the close.
   *
   * `null` means "cannot say", NOT "zero". The distinction is load-bearing: a
   * zero budget caps every projection to the break level and silently erases
   * the boxes, so a missing daily ATR must never masquerade as a measurement of
   * no room. Callers apply the cap when this is a number and skip capping (and
   * say the budget was not checked) when it is null.
   */
  points: number | null;
  /** 0..1. 1 before the open, 0 once the session has closed. */
  sessionFractionLeft: number;
  /** Today's high-low range in daily-ATR units. null when either is missing. */
  rangeConsumedAtr: number | null;
  /** One plain sentence for the Setup & Context card. */
  reason: string;
}

/**
 * The remaining-travel model, and its assumption.
 *
 *   points = dailyAtr × sessionFractionLeft × max(0.25, 1 − rangeConsumedAtr)
 *
 * Read as two independent haircuts on one ATR of travel:
 *
 * 1. **Range mean-reverts.** ATR(14) daily IS the typical day's high-low range,
 *    so `1 − consumed` is the share of a typical day's range this day has not
 *    yet produced. A day already 1.5x its ATR is not owed more travel because
 *    it has been busy — it is, if anything, closer to done, which is why the
 *    term shrinks rather than grows with consumption and is floored rather than
 *    allowed to go negative. This is the term that would have killed the 113.
 * 2. **Travel needs time.** Whatever range is left has to fit in the session
 *    that is left, so it scales with `sessionFractionLeft`.
 *
 * **Stated assumption: range accrues LINEARLY in session time.** It does not —
 * real intraday range grows roughly with the square root of elapsed time, so a
 * linear model under-credits the open and over-credits the last hour. We use it
 * anyway because it is one multiplication a trader can verify by eye, and
 * because a sqrt model would change the number by less than the spread between
 * two plausible ATR readings. A defensible simple model beats invented
 * precision.
 *
 * The result is an OPTIMISTIC bound, and intentionally so: it is the remaining
 * RANGE, and a single directional move can in the best case consume all of it.
 * A cap tighter than the best case it exists to permit would reject good
 * projections, which is a worse failure than admitting an impossible one.
 *
 * Not modelled: holidays. We carry no trading calendar, so a Sunday noon reads
 * as an open session. Harmless here — on a non-trading day there are no candles
 * to project from, so nothing consumes the budget.
 */
export function sessionBudget(input: SessionBudgetInput): SessionBudget {
  const hours = sessionHours(input?.exchange);
  const nowMin = istMinuteOfDay(input?.now);

  // An unusable clock is not a closed session. Say so rather than returning a
  // 0 fraction, which would read as "the day is over".
  if (nowMin === null) {
    return {
      points: null,
      sessionFractionLeft: 0,
      rangeConsumedAtr: null,
      reason: 'The current time is unreadable, so the remaining session cannot be measured.',
    };
  }

  const total = hours.closeMin - hours.openMin;
  const remaining = Math.min(Math.max(hours.closeMin - nowMin, 0), total);
  const fraction = round(remaining / total, 4);

  const range = todayRange(input);
  const atr = isPositive(input?.dailyAtr) ? (input.dailyAtr as number) : null;
  const rangeConsumedAtr = atr !== null && range !== null ? round(range / atr, 4) : null;

  // Session over. This IS a measurement — there is no more day, whatever the
  // ATR says — so it reports 0, unlike the "cannot say" cases below.
  if (fraction === 0) {
    return {
      points: 0,
      sessionFractionLeft: 0,
      rangeConsumedAtr,
      reason: `The ${hours.closeLabel} session is over; no further travel is available today.`,
    };
  }

  if (atr === null) {
    return {
      points: null,
      sessionFractionLeft: fraction,
      rangeConsumedAtr: null,
      reason: 'No daily ATR is available, so the travel still left in the session is unknown.',
    };
  }

  if (rangeConsumedAtr === null) {
    // Assuming "nothing consumed yet" here would be the most permissive guess
    // available and would defeat the cap on exactly the days it exists for.
    return {
      points: null,
      sessionFractionLeft: fraction,
      rangeConsumedAtr: null,
      reason:
        "Today's high and low are unavailable, so the travel still left in the session is unknown.",
    };
  }

  const headroomAtr = Math.max(RESIDUAL_EXPANSION_ATR, 1 - rangeConsumedAtr);
  const points = round(atr * fraction * headroomAtr, 2);

  return {
    points,
    sessionFractionLeft: fraction,
    rangeConsumedAtr,
    reason:
      `About ${points.toFixed(2)} points of further travel are likely before the ` +
      `${hours.closeLabel} close: ${Math.round(fraction * 100)}% of the session remains and ` +
      `today's range has already used ${rangeConsumedAtr.toFixed(2)}x the daily ATR.`,
  };
}

/**
 * Only MCX keeps commodity hours. Every other venue this platform touches —
 * NSE, BSE and their derivative segments — trades the equity session, so an
 * unrecognised string falls back to equity hours rather than to nothing: a
 * mis-typed exchange should narrow a projection to the common case, never
 * suppress the whole budget.
 */
function sessionHours(exchange: string | null | undefined): SessionHours {
  return typeof exchange === 'string' && exchange.trim().toUpperCase() === 'MCX'
    ? COMMODITY_HOURS
    : EQUITY_HOURS;
}

/** Minutes past IST midnight, or null when the Date is unusable. */
function istMinuteOfDay(now: Date | null | undefined): number | null {
  const ms = now?.getTime?.();
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const istMinutes = Math.floor((ms + IST_OFFSET_MS) / MS_PER_MINUTE);
  // `%` keeps the sign of the dividend; add a day before taking it again so a
  // pre-epoch date (a bad parse, most likely) still lands in [0, 1440).
  return ((istMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Today's high-low range, or null when either side is missing or nonsensical. */
function todayRange(input: SessionBudgetInput): number | null {
  const high = input?.todayHigh;
  const low = input?.todayLow;
  if (!isPositive(high) || !isPositive(low)) return null;
  const range = (high as number) - (low as number);
  // A high below its low is a corrupt book, not a zero-range day. Refuse to
  // measure rather than report a negative range that would inflate the budget.
  return range >= 0 ? range : null;
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
