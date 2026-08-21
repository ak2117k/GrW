/**
 * When each exchange is actually trading.
 *
 * WHY THIS EXISTS. The sentinel's session gate was one pair of constants —
 * 09:15 and 15:30 — applied to every position regardless of where it trades.
 * That is correct for NSE and wrong for MCX, which runs until 23:30. A
 * commodity position was therefore STRUCTURALLY UNWATCHED for eight hours of
 * its own trading day: the runner returned early on every tick, no sensor ran,
 * no verdict was written, and nothing anywhere said so. A quiet monitor is
 * indistinguishable from a calm market — the failure this whole module is built
 * to prevent, reproduced in its own scheduler.
 *
 * The platform already contained the evidence: `/healthz` reports
 * `feedThinksMarketOpen: true` beside `session.marketOpen: false` at 16:30,
 * because the market feed knows about MCX and this did not. Two components
 * disagreeing about whether the market is open IS the bug.
 *
 * PURE, and importing nothing. `sentinel-cycle.service.ts` reaches this through
 * the roster and the packet builder, and the Stage-0 property asserted by
 * `sentinel-cycle.service.spec.ts` is that no order-placing module is reachable
 * by following imports from the cycle. Same reason `charges.ts` and `symbols.ts`
 * import nothing.
 *
 * HOLIDAYS ARE NOT MODELLED, deliberately and as before. The cost of being wrong
 * is one wasted poll on a holiday, against the cost of a holiday calendar that
 * silently rots. The weekend IS modelled, because it is half of every week.
 */

/** IST is UTC + 5:30. Same convention as `common/utils/market-hours.ts`. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Minutes since IST midnight, and the IST weekday. */
function istParts(now: Date): { minutes: number; day: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    day: ist.getUTCDay(),
  };
}

/** One exchange's regular session, as minutes since IST midnight. */
export interface SessionWindow {
  openMin: number;
  closeMin: number;
}

/**
 * The equity session — NSE, BSE and their derivative segments NFO/BFO, which
 * trade the same hours as the cash market they derive from.
 */
export const EQUITY_SESSION: SessionWindow = { openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 };

/**
 * MCX commodities. The evening session is the whole point of this file: MCX runs
 * to 23:30, and a crude-oil or gold contract is at its most volatile long after
 * the equity market has shut.
 *
 * 23:30 is the standard close; MCX moves it to 23:55 during US daylight-saving
 * months. The earlier time is used because the error is one-sided: closing the
 * watch 25 minutes early on some days costs a few polls, while claiming a
 * session is open when it is not would have the agent judging a frozen price —
 * and this codebase has already paid for a stale price treated as live.
 */
export const COMMODITY_SESSION: SessionWindow = { openMin: 9 * 60, closeMin: 23 * 60 + 30 };

/** Currency derivatives. Included for completeness; nothing here trades them yet. */
export const CURRENCY_SESSION: SessionWindow = { openMin: 9 * 60, closeMin: 17 * 60 };

/**
 * Which session an exchange keeps. Unknown exchanges fall back to the EQUITY
 * window — the NARROWEST of the three, so an unrecognised venue is watched for
 * less time rather than judged on prices that are not moving.
 */
export function sessionFor(exchange: string): SessionWindow {
  switch (String(exchange ?? '').trim().toUpperCase()) {
    case 'MCX':
      return COMMODITY_SESSION;
    case 'CDS':
    case 'BCD':
      return CURRENCY_SESSION;
    default:
      return EQUITY_SESSION;
  }
}

/**
 * Could ANY venue on this platform be trading right now? A cheap pre-gate.
 *
 * WHY IT EXISTS. Gating per user requires knowing what each user holds, which
 * requires a database query — so a naive per-user gate turns a tick that used to
 * return instantly at 03:00 into a round trip to a remote serverless Postgres,
 * every 30 seconds, forever. That is precisely the constant background load just
 * removed from the tracker's quote sweep, reintroduced one module over.
 *
 * So: the widest window any exchange keeps (MCX, 09:00–23:30) plus the weekend
 * rule, evaluated from the clock alone. Outside it nothing can be open, so there
 * is nothing to ask the database about. Inside it, the per-user gate decides.
 */
export function isAnyMarketOpen(now: Date = new Date()): boolean {
  const { minutes, day } = istParts(now);
  if (day === 0 || day === 6) return false;
  const widestOpen = Math.min(EQUITY_SESSION.openMin, COMMODITY_SESSION.openMin);
  const widestClose = Math.max(EQUITY_SESSION.closeMin, COMMODITY_SESSION.closeMin);
  return minutes >= widestOpen && minutes < widestClose;
}

/** Whether `exchange` is trading at `now`. Weekends are closed everywhere. */
export function isExchangeOpen(exchange: string, now: Date = new Date()): boolean {
  const { minutes, day } = istParts(now);
  if (day === 0 || day === 6) return false;
  const { openMin, closeMin } = sessionFor(exchange);
  return minutes >= openMin && minutes < closeMin;
}

/**
 * Whether ANY of the exchanges a user actually holds is trading.
 *
 * ANY rather than ALL, and per user rather than globally. A book of one NFO
 * option and one MCX future is watchable from 09:00 to 23:30 — but only the
 * commodity is worth waking for after 15:30, and the roster's per-position
 * evaluation already handles which ones get looked at. Gating globally instead
 * would let one tenant's commodity position keep every other tenant's equity
 * positions being polled all evening, spending money to re-read frozen prices.
 *
 * An empty list is CLOSED. No holdings means nothing to watch, and defaulting
 * an unknown book to "open" would poll it forever.
 */
export function isAnyExchangeOpen(
  exchanges: readonly string[],
  now: Date = new Date(),
): boolean {
  return exchanges.some((exchange) => isExchangeOpen(exchange, now));
}

/**
 * Minutes remaining in `exchange`'s session, or null when it is already closed
 * (or it is the weekend).
 *
 * Null is a first-class answer and the caller renders it as a stated absence:
 * "how long have I got" has no answer outside a session, and reporting 0 would
 * read as "the bell is about to ring".
 */
export function minutesToClose(exchange: string, now: Date = new Date()): number | null {
  const { minutes, day } = istParts(now);
  if (day === 0 || day === 6) return null;
  const { openMin, closeMin } = sessionFor(exchange);
  if (minutes < openMin || minutes >= closeMin) return null;
  return closeMin - minutes;
}
