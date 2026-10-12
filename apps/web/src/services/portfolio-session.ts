/**
 * Per-exchange session gate for the Portfolio page's auto-refresh.
 *
 * `refresh-policy.marketPhase` answers "is ANY venue open" — right for screens
 * that show everything, wrong for a broker-backed pull: every
 * `/broker/overview` call is a real Angel One login, so at 19:30 we only want
 * to pay for it when the user actually holds something that is still trading
 * (MCX). These helpers answer "is THIS exchange in session", per instrument.
 *
 * Weekends are respected; exchange holidays are not known client-side (the
 * backend's `SessionClock` owns the holiday list) — on a holiday the page
 * polls a shut market, which costs a few cheap/broker reads and nothing else.
 */

/** IST wall-clock minutes past midnight, plus the weekday, for an instant. */
function istParts(now: Date): { minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { minutes: hour * 60 + minute, weekday: parts.find((p) => p.type === 'weekday')?.value ?? '' };
}

const NSE_OPEN = 9 * 60 + 15; // 09:15
const NSE_CLOSE = 15 * 60 + 30; // 15:30
const MCX_OPEN = 9 * 60; // 09:00
/**
 * 23:55 — MCX's late close during the US-DST-linked window (Nov–Mar). Using
 * the late close all year costs at most 25 idle minutes of polling in summer;
 * using 23:30 would freeze the page for the last 25 minutes in winter.
 */
const MCX_CLOSE = 23 * 60 + 55;

/** Commodity venues that trade into the evening. */
const EVENING_EXCHANGES = new Set(['MCX', 'NCDEX', 'NCO']);

/**
 * Is `exchange` in its trading session at `now` (IST)? NSE/BSE/NFO/BFO/CDS —
 * and anything unrecognised — use equity hours (09:15–15:30); MCX/NCDEX use
 * 09:00–23:55. Mon–Fri only.
 */
export function exchangeInSession(exchange: string, now: Date = new Date()): boolean {
  const { minutes, weekday } = istParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (EVENING_EXCHANGES.has((exchange ?? '').toUpperCase())) {
    return minutes >= MCX_OPEN && minutes <= MCX_CLOSE;
  }
  return minutes >= NSE_OPEN && minutes <= NSE_CLOSE;
}

/**
 * Should the page re-pull the broker overview (a broker login) now?
 * Yes during the NSE/NFO session; outside it, only when one of the user's
 * held instruments (`heldExchanges`) is itself still trading — i.e. an MCX
 * holding during the evening session.
 */
export function shouldAutoRefreshPortfolio(
  heldExchanges: Iterable<string>,
  now: Date = new Date(),
): boolean {
  if (exchangeInSession('NSE', now)) return true;
  for (const ex of heldExchanges) {
    if (exchangeInSession(ex, now)) return true;
  }
  return false;
}

/**
 * The exchanges the user currently holds something on: every overview
 * position and holding, plus every OPEN tracker (which also covers the moment
 * before the first overview pull lands).
 */
export function collectHeldExchanges(
  overview:
    | {
        positions?: ReadonlyArray<{ exchange: string }> | null;
        holdings?: ReadonlyArray<{ exchange: string }> | null;
      }
    | null
    | undefined,
  trackers: ReadonlyArray<{ exchange: string; status: string }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const p of overview?.positions ?? []) if (p.exchange) out.add(p.exchange.toUpperCase());
  for (const h of overview?.holdings ?? []) if (h.exchange) out.add(h.exchange.toUpperCase());
  for (const t of trackers ?? []) {
    if (t.status === 'OPEN' && t.exchange) out.add(t.exchange.toUpperCase());
  }
  return out;
}

/** True when at least one OPEN tracker's exchange is in session at `now`. */
export function hasOpenInSessionTracker(
  trackers: ReadonlyArray<{ exchange: string; status: string }> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!trackers) return false;
  return trackers.some((t) => t.status === 'OPEN' && exchangeInSession(t.exchange, now));
}
