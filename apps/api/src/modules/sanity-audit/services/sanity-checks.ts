import type { SessionClock } from '../../market-hub/session-clock';
import {
  exitNearTrigger,
  feedFresh,
  lastDueReviewSession,
  noiseFollowUpFilled,
  noiseReadPresent,
  NOISE_FOLLOW_DUE_MIN,
  NOISE_READ_SINCE,
  OI_CHECK_SINCE,
  OI_OPEN_GRACE_MIN,
  oiCheckPresent,
  paperFillVsLtp,
  pnlArithmetic,
  selfReviewRan,
  type Finding,
  type Severity,
} from '../domain/checks';
import type { SanityAuditRepository } from '../repositories/sanity-audit.repository';

const MIN = 60_000;

export interface CheckContext {
  now: Date;
  /** Subjects older than this are not loaded (the first run still sees the 28–30 Oct cases). */
  from: Date;
  clock: SessionClock;
  env: Record<string, string | undefined>;
}

/**
 * One invariant: `load` runs the read-only query, `evaluate` is the pure check per row. Several entries
 * may share a `check` name (JOBS_RAN is four heartbeats); subject ids stay distinct across them.
 */
export interface SanityCheck<R = unknown> {
  check: string;
  /** Short name of this entry, for logs. */
  id: string;
  severity: Exclude<Severity, 'known'>;
  load(repo: SanityAuditRepository, ctx: CheckContext): Promise<R[]>;
  evaluate(row: R, ctx: CheckContext): Finding | null;
}

const later = (a: Date, b: Date) => (a > b ? a : b);
const def = <R>(c: SanityCheck<R>): SanityCheck => c as unknown as SanityCheck;

/** IST minutes since the venue's open today, or null when it is not in session. */
function minutesSinceOpen(clock: SessionClock, exchange: string, now: Date): number | null {
  if (!clock.isOpen(exchange, now)) return null;
  const w = clock.tradingWindow(exchange, now);
  if (!w) return null;
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() - w.openMin;
}

/** Add an invariant: append an entry here (and a pure function + spec in domain/checks.ts). */
export const SANITY_CHECKS: readonly SanityCheck[] = [
  def({
    check: 'PAPER_FILL_VS_LTP',
    id: 'paper-fill',
    severity: 'error',
    load: (repo, ctx) => repo.paperFills(ctx.from),
    evaluate: (row) => paperFillVsLtp(row),
  }),
  def({
    check: 'PNL_ARITHMETIC',
    id: 'pnl',
    severity: 'error',
    load: (repo, ctx) => repo.closedTrades(ctx.from),
    evaluate: (row) => pnlArithmetic(row),
  }),
  def({
    check: 'EXIT_NEAR_TRIGGER',
    id: 'exit-price',
    severity: 'warn',
    load: (repo, ctx) => repo.aiExits(ctx.from),
    evaluate: (row) => exitNearTrigger(row),
  }),
  def({
    check: 'RECORDS_PRESENT',
    id: 'oi-check',
    severity: 'warn',
    load: (repo, ctx) => repo.paperOpens(later(ctx.from, OI_CHECK_SINCE)),
    evaluate: (row, ctx) => oiCheckPresent(row, ctx.now),
  }),
  def({
    check: 'RECORDS_PRESENT',
    id: 'noise-read',
    severity: 'warn',
    load: (repo, ctx) => repo.aiExitRecords(later(ctx.from, NOISE_READ_SINCE)),
    evaluate: (row, ctx) => noiseReadPresent(row, ctx.now),
  }),
  def({
    check: 'JOBS_RAN',
    id: 'oi-feed',
    severity: 'warn',
    load: async (repo, ctx) => {
      const since = minutesSinceOpen(ctx.clock, 'NFO', ctx.now);
      const dueNow = since !== null && since >= OI_OPEN_GRACE_MIN;
      if (!dueNow) return [];
      const beat = await repo.nfoOiBeat(ctx.now);
      return [
        { feed: 'oi-nfo', label: 'oi_snapshots NFO', lastAt: beat.lastAny, dueNow },
        { feed: 'oi-nfo-fut', label: 'oi_snapshots NFO futures (ltp)', lastAt: beat.lastFutLtp, dueNow },
      ];
    },
    evaluate: (row, ctx) => feedFresh(row, ctx.now),
  }),
  def({
    check: 'JOBS_RAN',
    id: 'noise-follow',
    severity: 'warn',
    load: async (repo, ctx) => {
      const rows = await repo.unfilledNoiseFollows(later(ctx.from, NOISE_READ_SINCE), new Date(ctx.now.getTime() - NOISE_FOLLOW_DUE_MIN * MIN));
      // A read whose +30 min falls after its underlying's close can never be filled: legit null.
      return rows.map((r) => ({ ...r, venueOpenAt30m: !!r.underlyingExchange && ctx.clock.isOpen(r.underlyingExchange, new Date(r.exitAt.getTime() + 30 * MIN)) }));
    },
    evaluate: (row, ctx) => noiseFollowUpFilled(row, ctx.now),
  }),
  def({
    check: 'JOBS_RAN',
    id: 'self-review',
    severity: 'warn',
    load: async (repo, ctx) => {
      const off = (ctx.env.SELF_REVIEW_ENABLED ?? '').trim().toLowerCase();
      if (off === 'false' || off === 'off' || off === '0') return [];
      const due = lastDueReviewSession(ctx.now, (at) => ctx.clock.isTradingDay('NSE', at));
      if (!due || due.deadline < ctx.from) return [];
      return [{ ...due, firstDoneAt: await repo.firstDoneReview(due.session) }];
    },
    evaluate: (row, ctx) => selfReviewRan(row, ctx.now),
  }),
];
