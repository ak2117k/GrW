/**
 * Sanity-audit invariants (owner 2026-10-30). DETECTION ONLY: each function takes the facts one query
 * row carries and says whether an invariant is broken. Pure — no I/O, no clock reads (`now` is passed).
 *
 * Why: three silent data bugs in one week were found only because the owner eyeballed odd numbers —
 * paper closes double-counting P&L (28–29 Oct), signal paper fills at the marketable limit instead of
 * the LTP (NIFTY23NOV26FUT 23169 vs 23048, fixed c6fc825), the journal "Current" showing the exit price.
 */

const MIN = 60_000;

export type Severity = 'error' | 'warn' | 'known';

/** One broken invariant on one subject (a trade, an exit, a feed-day). */
export interface Finding {
  /** Stable id of what broke — with the check name, the idempotency key of the violation row. */
  subjectId: string;
  /** When the subject came to be (trade open / close, exit, window): decides 'known' vs alert. */
  subjectAt: Date;
  /** One short plain line: which trade / symbol, expected vs actual. */
  message: string;
  detail: Record<string, unknown>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (actual: number, expected: number) => ((actual - expected) / expected) * 100;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${r2(x)}`;

// ── 1. PAPER_FILL_VS_LTP ────────────────────────────────────────────────────────────────────────────

/** The paper slippage model is 0.01–0.05 %; a fill this far from the decision LTP is a wrong price. */
export const PAPER_FILL_MAX_PCT = 0.2;

export interface PaperFillRow {
  tradeId: string;
  symbol: string;
  side: string;
  entryPrice: number | null;
  /** signal_decisions.plan->>'ltp' at decision time. */
  planLtp: number | null;
  openedAt: Date;
}

/** A Telegram-signal paper fill must sit within PAPER_FILL_MAX_PCT of the plan LTP (either side). */
export function paperFillVsLtp(r: PaperFillRow): Finding | null {
  if (r.entryPrice === null || r.planLtp === null || !(r.entryPrice > 0) || !(r.planLtp > 0)) return null;
  const off = pct(r.entryPrice, r.planLtp);
  if (Math.abs(off) <= PAPER_FILL_MAX_PCT) return null;
  return {
    subjectId: r.tradeId,
    subjectAt: r.openedAt,
    message: `${r.symbol} ${r.side} paper fill ${r2(r.entryPrice)} vs plan LTP ${r.planLtp} (${signed(off)}%, max ±${PAPER_FILL_MAX_PCT}%) — trade ${r.tradeId}`,
    detail: { symbol: r.symbol, side: r.side, entryPrice: r.entryPrice, planLtp: r.planLtp, offPct: r2(off), maxPct: PAPER_FILL_MAX_PCT },
  };
}

// ── 2. PNL_ARITHMETIC ───────────────────────────────────────────────────────────────────────────────

export const PNL_TOLERANCE_RUPEES = 1;

export interface ClosedTradeRow {
  tradeId: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnl: number | null;
  exitAt: Date;
  /** trade_events PARTIAL_EXIT rows of the trade. */
  partialExits: number;
}

/**
 * trades.pnl is GROSS side × (exit − entry) × qty (fees separate). A trade with partial exits keeps the
 * cumulative realised P&L while `quantity` shrinks to the last slice (trade-execution closeTrade), so the
 * formula does not hold for it and it is skipped — legit, not a violation.
 */
export function pnlArithmetic(r: ClosedTradeRow): Finding | null {
  if (r.partialExits > 0 || r.pnl === null || r.entryPrice === null || r.exitPrice === null) return null;
  const sign = r.side === 'SELL' ? -1 : 1;
  const expected = sign * (r.exitPrice - r.entryPrice) * r.quantity;
  const diff = r.pnl - expected;
  if (Math.abs(diff) <= PNL_TOLERANCE_RUPEES) return null;
  return {
    subjectId: r.tradeId,
    subjectAt: r.exitAt,
    message: `${r.symbol} ${r.side} ${r.quantity} @ ${r2(r.entryPrice)} → ${r2(r.exitPrice)}: pnl ₹${r2(r.pnl)}, expected ₹${r2(expected)} (off ₹${r2(diff)}) — trade ${r.tradeId}`,
    detail: { symbol: r.symbol, side: r.side, quantity: r.quantity, entryPrice: r.entryPrice, exitPrice: r.exitPrice, pnl: r.pnl, expected: r2(expected), diff: r2(diff) },
  };
}

// ── 3. EXIT_NEAR_TRIGGER ────────────────────────────────────────────────────────────────────────────

/**
 * Thresholds from prod 28–30 Oct: an underlying-trigger exit fills between sentinel looks, so its premium
 * has moved since the last look — legit gaps reached 8.5 % on an option 10 min after the look
 * (LAURUSLABS 2400CE 57.6 → 52.7) and 0.9 % on a stock. Deep-OTM real exits move rupee-ticks that are
 * huge percentages (0.3 → 0.2), hence the absolute floors. A premium trigger fills AT its crossing price.
 */
export const EXIT_OPTION_MAX_PCT = 15;
export const EXIT_OPTION_MIN_RUPEES = 2;
export const EXIT_OTHER_MAX_PCT = 3;
export const EXIT_OTHER_MIN_RUPEES = 1;
export const EXIT_PREMIUM_TRIGGER_MAX_PCT = 2;
/** A look older than this before the exit is no anchor: the exit is not judged. */
export const EXIT_LOOK_MAX_AGE_MIN = 30;

export interface AiExitRow {
  /** trades.id (paper) or ai_exit_executions.id (real). */
  subjectId: string;
  kind: 'paper' | 'real';
  symbol: string;
  exitPrice: number | null;
  exitAt: Date;
  /** trades.exitNotes (paper) — carries "PREMIUM BELOW 147.43 crossed (147.41)" for a premium trigger. */
  notes: string | null;
  /** packet.position.ltp of the newest sentinel look at or before the exit. */
  lookLtp: number | null;
  lookAt: Date | null;
}

const isOption = (symbol: string) => /(CE|PE)$/i.test(symbol);
const PREMIUM_TRIGGER = /PREMIUM\s+(?:BELOW|ABOVE)\s+[\d.]+\s+crossed\s+\(([\d.]+)\)/i;

/** An AI exit's price must be sane against what the AI last saw (or, for a premium trigger, its crossing). */
export function exitNearTrigger(r: AiExitRow): Finding | null {
  if (r.exitPrice === null || !(r.exitPrice > 0)) return null;
  const crossed = r.notes ? PREMIUM_TRIGGER.exec(r.notes) : null;
  if (crossed && Number(crossed[1]) > 0) {
    const anchor = Number(crossed[1]);
    const off = pct(r.exitPrice, anchor);
    if (Math.abs(off) <= EXIT_PREMIUM_TRIGGER_MAX_PCT) return null;
    return {
      subjectId: r.subjectId,
      subjectAt: r.exitAt,
      message: `${r.symbol} ${r.kind} AI premium-trigger exit ${r2(r.exitPrice)} vs crossing ${anchor} (${signed(off)}%, max ±${EXIT_PREMIUM_TRIGGER_MAX_PCT}%) — ${r.subjectId}`,
      detail: { symbol: r.symbol, kind: r.kind, exitPrice: r.exitPrice, anchor, anchorSource: 'premium trigger crossing', offPct: r2(off) },
    };
  }
  if (r.lookLtp === null || !(r.lookLtp > 0) || !r.lookAt) return null;
  const ageMin = (r.exitAt.getTime() - r.lookAt.getTime()) / MIN;
  if (ageMin < 0 || ageMin > EXIT_LOOK_MAX_AGE_MIN) return null;
  const opt = isOption(r.symbol);
  const maxPct = opt ? EXIT_OPTION_MAX_PCT : EXIT_OTHER_MAX_PCT;
  const minRupees = opt ? EXIT_OPTION_MIN_RUPEES : EXIT_OTHER_MIN_RUPEES;
  const diff = r.exitPrice - r.lookLtp;
  const allowed = Math.max((maxPct / 100) * r.lookLtp, minRupees);
  if (Math.abs(diff) <= allowed) return null;
  const off = pct(r.exitPrice, r.lookLtp);
  return {
    subjectId: r.subjectId,
    subjectAt: r.exitAt,
    message: `${r.symbol} ${r.kind} AI exit ${r2(r.exitPrice)} vs last look LTP ${r.lookLtp} ${Math.round(ageMin)} min earlier (${signed(off)}%, max ±${maxPct}% / ₹${minRupees}) — ${r.subjectId}`,
    detail: { symbol: r.symbol, kind: r.kind, exitPrice: r.exitPrice, anchor: r.lookLtp, anchorSource: 'last sentinel look', lookAgeMin: r2(ageMin), offPct: r2(off), maxPct, minRupees },
  };
}

// ── 4. RECORDS_PRESENT ──────────────────────────────────────────────────────────────────────────────

/** A record written after a decision / exit must land within this. */
export const RECORD_GRACE_MIN = 5;
/** The OI check shipped on paper opens from here (UTC). Earlier opens never had one. */
export const OI_CHECK_SINCE = new Date('2026-10-30T05:20:00Z');
/** The exit noise read shipped on AI exits from here (UTC). */
export const NOISE_READ_SINCE = new Date('2026-10-30T09:24:00Z');

export interface PaperOpenRow {
  decisionId: string;
  tradeId: string;
  symbol: string | null;
  /** plan.paper.at — when the paper trade opened. */
  openedAt: Date;
  hasOiCheck: boolean;
  /** oi_check.at, when present. */
  oiCheckAt: Date | null;
}

/** Every signal paper open carries an OI check (signal_decisions.oi_check) within RECORD_GRACE_MIN. */
export function oiCheckPresent(r: PaperOpenRow, now: Date): Finding | null {
  if (r.openedAt < OI_CHECK_SINCE) return null;
  const grace = RECORD_GRACE_MIN * MIN;
  const what = `${r.symbol ?? '?'} paper open (decision ${r.decisionId}, trade ${r.tradeId})`;
  if (!r.hasOiCheck) {
    if (now.getTime() - r.openedAt.getTime() <= grace) return null; // still inside its window
    return { subjectId: r.decisionId, subjectAt: r.openedAt, message: `${what}: no oi_check ${RECORD_GRACE_MIN}+ min after the open`, detail: { tradeId: r.tradeId, symbol: r.symbol, openedAt: r.openedAt.toISOString(), oiCheckAt: null } };
  }
  if (r.oiCheckAt && r.oiCheckAt.getTime() - r.openedAt.getTime() > grace) {
    const late = r2((r.oiCheckAt.getTime() - r.openedAt.getTime()) / MIN);
    return { subjectId: r.decisionId, subjectAt: r.openedAt, message: `${what}: oi_check written ${late} min after the open (max ${RECORD_GRACE_MIN})`, detail: { tradeId: r.tradeId, symbol: r.symbol, openedAt: r.openedAt.toISOString(), oiCheckAt: r.oiCheckAt.toISOString(), lateMin: late } };
  }
  return null;
}

export interface AiExitRecordRow {
  /** trades.id (paper) or ai_exit_executions.id (real). */
  subjectId: string;
  kind: 'paper' | 'real';
  symbol: string;
  exitAt: Date;
  /** exit_noise_reads.created_at of its read, null when there is none. */
  readAt: Date | null;
}

/** Every AI exit (paper close or real execution sent / filled / rehearsed) has an exit_noise_reads row. */
export function noiseReadPresent(r: AiExitRecordRow, now: Date): Finding | null {
  if (r.exitAt < NOISE_READ_SINCE) return null;
  const grace = RECORD_GRACE_MIN * MIN;
  const what = `${r.symbol} ${r.kind} AI exit ${r.subjectId}`;
  if (!r.readAt) {
    if (now.getTime() - r.exitAt.getTime() <= grace) return null;
    return { subjectId: r.subjectId, subjectAt: r.exitAt, message: `${what}: no exit_noise_reads row ${RECORD_GRACE_MIN}+ min after the exit`, detail: { kind: r.kind, symbol: r.symbol, exitAt: r.exitAt.toISOString(), readAt: null } };
  }
  if (r.readAt.getTime() - r.exitAt.getTime() > grace) {
    const late = r2((r.readAt.getTime() - r.exitAt.getTime()) / MIN);
    return { subjectId: r.subjectId, subjectAt: r.exitAt, message: `${what}: noise read written ${late} min after the exit (max ${RECORD_GRACE_MIN})`, detail: { kind: r.kind, symbol: r.symbol, exitAt: r.exitAt.toISOString(), readAt: r.readAt.toISOString(), lateMin: late } };
  }
  return null;
}

// ── 5. JOBS_RAN ─────────────────────────────────────────────────────────────────────────────────────

/** NFO OI snapshots land every ~1–5 min in session (prod 27–30 Oct: max gap 5 min). */
export const OI_STALE_MIN = 10;
/** No staleness call until the feed had this long after the open. */
export const OI_OPEN_GRACE_MIN = 10;
/** A noise read's 30-min follow-up must be filled this long after the exit. */
export const NOISE_FOLLOW_DUE_MIN = 60;
/** The nightly self-review of session D must have run by D+1 01:00 IST (it runs at 18:45 IST). */
export const SELF_REVIEW_DEADLINE_IST_MIN = 60;

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export interface FeedBeatRow {
  /** 'oi-nfo' (any NFO snapshot) or 'oi-nfo-fut' (NFO futures rows with ltp). */
  feed: string;
  label: string;
  lastAt: Date | null;
  /** The venue is in session now and has been for OI_OPEN_GRACE_MIN. */
  dueNow: boolean;
}

/** In session, the feed wrote a row within OI_STALE_MIN. One finding per feed per IST day. */
export function feedFresh(r: FeedBeatRow, now: Date): Finding | null {
  if (!r.dueNow) return null;
  const ageMin = r.lastAt ? (now.getTime() - r.lastAt.getTime()) / MIN : null;
  if (ageMin !== null && ageMin <= OI_STALE_MIN) return null;
  return {
    subjectId: `${r.feed}:${istDate(now)}`,
    subjectAt: now,
    message: `${r.label}: newest row ${ageMin === null ? 'none in the last hour' : `${Math.round(ageMin)} min old`} during the session (max ${OI_STALE_MIN} min)`,
    detail: { feed: r.feed, lastAt: r.lastAt ? r.lastAt.toISOString() : null, ageMin: ageMin === null ? null : r2(ageMin), maxMin: OI_STALE_MIN },
  };
}

export interface NoiseFollowRow {
  id: string;
  symbol: string;
  exitAt: Date;
  after30m: number | null;
  /** The underlying's venue trades at exit + 30 min — else no bar can exist and null is legit. */
  venueOpenAt30m: boolean;
}

/** An exit noise read older than NOISE_FOLLOW_DUE_MIN has its underlying +30 min filled. */
export function noiseFollowUpFilled(r: NoiseFollowRow, now: Date): Finding | null {
  if (r.after30m !== null || !r.venueOpenAt30m) return null;
  const ageMin = (now.getTime() - r.exitAt.getTime()) / MIN;
  if (ageMin <= NOISE_FOLLOW_DUE_MIN) return null;
  return {
    subjectId: `noise-follow:${r.id}`,
    subjectAt: r.exitAt,
    message: `exit noise read ${r.id} (${r.symbol}): underlying_after_30m still empty ${Math.round(ageMin)} min after the exit (due by ${NOISE_FOLLOW_DUE_MIN})`,
    detail: { readId: r.id, symbol: r.symbol, exitAt: r.exitAt.toISOString(), ageMin: Math.round(ageMin) },
  };
}

/**
 * The newest NSE session whose self-review deadline (next IST day 01:00) has passed at `now`, with that
 * deadline. Walks back over weekends / holidays via `isTradingDay` (asked at the session's IST noon).
 */
export function lastDueReviewSession(now: Date, isTradingDay: (at: Date) => boolean): { session: string; deadline: Date } | null {
  const DAY = 86_400_000;
  // IST midnight of the IST day whose 01:00 deadline is the newest one passed: (now − 1 h)'s IST date.
  const base = new Date(`${istDate(new Date(now.getTime() - SELF_REVIEW_DEADLINE_IST_MIN * MIN))}T00:00:00+05:30`).getTime();
  for (let back = 1; back <= 10; back++) {
    const sessionMidnight = base - back * DAY;
    if (!isTradingDay(new Date(sessionMidnight + 12 * 3_600_000))) continue;
    return { session: istDate(new Date(sessionMidnight)), deadline: new Date(sessionMidnight + DAY + SELF_REVIEW_DEADLINE_IST_MIN * MIN) };
  }
  return null;
}

export interface SelfReviewRow {
  session: string;
  deadline: Date;
  /** started_at of the first DONE self_review_runs row for the session, null when none. */
  firstDoneAt: Date | null;
}

/** The night's self-review of the session finished (DONE) by its deadline. */
export function selfReviewRan(r: SelfReviewRow, now: Date): Finding | null {
  if (now < r.deadline) return null;
  if (r.firstDoneAt && r.firstDoneAt <= r.deadline) return null;
  return {
    subjectId: `self-review:${r.session}`,
    subjectAt: r.deadline,
    message: r.firstDoneAt
      ? `self-review of ${r.session} ran late: first DONE run ${r.firstDoneAt.toISOString()} (due by 01:00 IST)`
      : `self-review of ${r.session}: no DONE run by 01:00 IST`,
    detail: { session: r.session, deadline: r.deadline.toISOString(), firstDoneAt: r.firstDoneAt ? r.firstDoneAt.toISOString() : null },
  };
}
