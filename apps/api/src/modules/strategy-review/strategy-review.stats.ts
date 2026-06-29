/**
 * Pure statistics functions for the strategy-review endpoint.
 *
 * NO database, NO NestJS — every function here takes plain arrays of
 * already-fetched objects and returns plain objects. All the analytics
 * math lives here so it can be unit-tested with synthetic fixtures.
 *
 * The review is re-based on WatchEntry rows: every watched Chartink alert
 * (~105/day) is a data point, NOT just the handful that became trades.
 * This gives a real statistical sample. Executed paper trades are still
 * reported, but kept SEPARATE (the `realized` block) so live-money math
 * is never blended with watch-outcome math.
 *
 * Outcome conventions (a "watch entry"):
 *  - WIN      = status === 'TARGET_HIT'
 *  - LOSS     = status === 'STOPPED'
 *  - resolved = WIN + LOSS
 *  - open     = WATCHING + TRADED
 *  - EXITED / DISMISSED count toward the total only.
 *
 * Per-entry MFE/MAE (side-adjusted, favorable -> positive):
 *  - sideMul = side === 'BUY' ? 1 : -1
 *  - mfePct  = ((maxFavorable - initialPrice)/initialPrice)*100*sideMul
 *  - maePct  = ((maxAdverse  - initialPrice)/initialPrice)*100*sideMul
 *  - entries with a null maxFavorable/maxAdverse are skipped when averaging.
 *
 * All percentages are 0 (never NaN) when the denominator is empty.
 */

// ---- Input shapes (plain, DB-agnostic) ------------------------------------

export interface FactorCheck {
  name: string;
  passed: boolean;
}

/** One WatchEntry row — a single watched Chartink alert. */
export interface StatWatch {
  id: string;
  scanner: string | null; // resolved scanner name
  side: string; // 'BUY' | 'SELL'
  status: string; // WatchStatus: WATCHING|TRADED|TARGET_HIT|STOPPED|EXITED|DISMISSED
  initialScore: number;
  initialPrice: number;
  maxFavorable: number | null;
  maxAdverse: number | null;
  initialAt: Date;
  paperTradeId: string | null; // === Trade.id when this watch was executed
  checks: FactorCheck[]; // from initialBreakdown.checks
}

/** One paper Trade row linked to a watch via paperTradeId. */
export interface StatTrade {
  id: string;
  status: string; // 'CLOSED' | 'OPEN' | ...
  pnl: number | null;
  fees: number;
  entryTime: Date | null;
}

// ---- Output shapes --------------------------------------------------------

export interface StrategyReviewSummary {
  watchEntries: number;
  resolved: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  executed: number;
  avgMfePct: number;
  avgMaePct: number;
}

export interface RealizedStats {
  closedTrades: number;
  winners: number;
  winRate: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  expectancy: number;
}

export interface ScannerRow {
  scanner: string;
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  avgMfePct: number;
  avgMaePct: number;
  executed: number;
}

export interface ScoreBucketRow {
  bucket: string;
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  avgMfePct: number;
  avgMaePct: number;
}

export interface FactorRow {
  factor: string;
  passResolved: number;
  passWins: number;
  passWinRate: number;
  failResolved: number;
  failWins: number;
  failWinRate: number;
  edge: number;
}

export interface DayRow {
  date: string; // "YYYY-MM-DD" — IST calendar date
  entries: number;
  resolved: number;
  wins: number;
  winRate: number;
  executed: number;
  realizedNetPnl: number;
}

// ---- Helpers --------------------------------------------------------------

/** Round to 2 decimals, guarding against -0 and NaN. */
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Round to 4 decimals — used for the MFE/MAE percentages where small
 * fractional differences are meaningful.
 */
function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Net P&L of a trade after fees. */
function netOf(t: StatTrade): number {
  return (t.pnl ?? 0) - (t.fees ?? 0);
}

function isClosed(t: StatTrade): boolean {
  return t.status === 'CLOSED';
}

function isWin(w: StatWatch): boolean {
  return w.status === 'TARGET_HIT';
}

function isLoss(w: StatWatch): boolean {
  return w.status === 'STOPPED';
}

function isResolved(w: StatWatch): boolean {
  return isWin(w) || isLoss(w);
}

function isOpen(w: StatWatch): boolean {
  return w.status === 'WATCHING' || w.status === 'TRADED';
}

/** +1 for BUY, -1 for SELL. */
function sideMul(side: string): number {
  return side.toUpperCase() === 'SELL' ? -1 : 1;
}

/**
 * Side-adjusted percentage move from a watch's initial price to a target
 * price. Favorable moves are positive for both BUY and SELL.
 */
function pctMove(w: StatWatch, target: number): number {
  if (!w.initialPrice) return 0;
  return ((target - w.initialPrice) / w.initialPrice) * 100 * sideMul(w.side);
}

/** Side-adjusted MFE% for a watch, or null when maxFavorable is absent. */
function mfePct(w: StatWatch): number | null {
  if (w.maxFavorable == null || !w.initialPrice) return null;
  return pctMove(w, w.maxFavorable);
}

/** Side-adjusted MAE% for a watch (negative = adverse), or null. */
function maePct(w: StatWatch): number | null {
  if (w.maxAdverse == null || !w.initialPrice) return null;
  return pctMove(w, w.maxAdverse);
}

/** Mean of every non-null MFE% across a set of watches. */
function avgMfe(watches: StatWatch[]): number {
  const xs = watches
    .map(mfePct)
    .filter((x): x is number => x != null);
  return round4(mean(xs));
}

/** Mean of every non-null MAE% across a set of watches. */
function avgMae(watches: StatWatch[]): number {
  const xs = watches
    .map(maePct)
    .filter((x): x is number => x != null);
  return round4(mean(xs));
}

/** Win-rate over a set of watches' resolved subset. */
function resolvedStats(watches: StatWatch[]): {
  resolved: number;
  wins: number;
  winRate: number;
} {
  const resolved = watches.filter(isResolved);
  const wins = resolved.filter(isWin).length;
  const winRate = resolved.length ? (wins / resolved.length) * 100 : 0;
  return { resolved: resolved.length, wins, winRate: round2(winRate) };
}

/** Map a score to its display bucket. Scores below 50 fall into "50-59". */
function scoreBucket(score: number): string {
  if (score >= 80) return '80+';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  return '50-59';
}

const SCORE_BUCKETS = ['50-59', '60-69', '70-79', '80+'] as const;

/**
 * The IST (UTC+5:30) calendar date of a UTC timestamp, as "YYYY-MM-DD".
 * DB timestamps are stored in UTC — shifting forward by 5h30m and then
 * reading the UTC date components yields the date as seen in India.
 */
function istDateKey(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- Public stat functions ------------------------------------------------

/**
 * Summary over EVERY watched alert in range. resolved/win/loss/open derive
 * from WatchEntry.status; executed counts entries with a paperTradeId;
 * MFE/MAE are averaged over every watch with the data present.
 */
export function computeSummary(watches: StatWatch[]): StrategyReviewSummary {
  const resolved = watches.filter(isResolved);
  const wins = resolved.filter(isWin).length;
  const losses = resolved.filter(isLoss).length;
  const open = watches.filter(isOpen).length;
  const winRate = resolved.length ? (wins / resolved.length) * 100 : 0;
  const executed = watches.filter((w) => w.paperTradeId != null).length;

  return {
    watchEntries: watches.length,
    resolved: resolved.length,
    wins,
    losses,
    open,
    winRate: round2(winRate),
    executed,
    avgMfePct: avgMfe(watches),
    avgMaePct: avgMae(watches),
  };
}

/**
 * Realized P&L over EXECUTED PAPER TRADES ONLY. A trade is counted only
 * when a watch entry's paperTradeId points at it AND the trade is CLOSED.
 * This is the real-money view, kept deliberately separate from the
 * watch-outcome stats so the two are never blended.
 */
export function computeRealized(
  watches: StatWatch[],
  trades: StatTrade[],
): RealizedStats {
  const tradeById = new Map(trades.map((t) => [t.id, t]));

  const executedTradeIds = new Set<string>();
  for (const w of watches) {
    if (w.paperTradeId) executedTradeIds.add(w.paperTradeId);
  }

  const closed: StatTrade[] = [];
  for (const id of executedTradeIds) {
    const t = tradeById.get(id);
    if (t && isClosed(t)) closed.push(t);
  }

  const grossPnl = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const fees = closed.reduce((a, t) => a + (t.fees ?? 0), 0);
  const netPnl = grossPnl - fees;
  const winners = closed.filter((t) => netOf(t) > 0).length;
  const winRate = closed.length ? (winners / closed.length) * 100 : 0;
  const expectancy = closed.length ? netPnl / closed.length : 0;

  return {
    closedTrades: closed.length,
    winners,
    winRate: round2(winRate),
    grossPnl: round2(grossPnl),
    fees: round2(fees),
    netPnl: round2(netPnl),
    expectancy: round2(expectancy),
  };
}

/**
 * Per-scanner breakdown over every watch entry. win-rate is computed over
 * that scanner's RESOLVED entries; MFE/MAE over every entry with the data.
 */
export function computeByScanner(watches: StatWatch[]): ScannerRow[] {
  const byScanner = new Map<string, StatWatch[]>();
  for (const w of watches) {
    if (!w.scanner) continue;
    const bucket = byScanner.get(w.scanner);
    if (bucket) bucket.push(w);
    else byScanner.set(w.scanner, [w]);
  }

  const rows: ScannerRow[] = [];
  for (const [scanner, group] of byScanner) {
    const r = resolvedStats(group);
    rows.push({
      scanner,
      entries: group.length,
      resolved: r.resolved,
      wins: r.wins,
      winRate: r.winRate,
      avgMfePct: avgMfe(group),
      avgMaePct: avgMae(group),
      executed: group.filter((w) => w.paperTradeId != null).length,
    });
  }

  // Deterministic order: most entries first, then name.
  rows.sort((a, b) => b.entries - a.entries || a.scanner.localeCompare(b.scanner));
  return rows;
}

/**
 * Per-score-bucket breakdown over every watch entry. Always emits all four
 * buckets ("50-59","60-69","70-79","80+") even when empty.
 */
export function computeByScoreBucket(watches: StatWatch[]): ScoreBucketRow[] {
  const byBucket = new Map<string, StatWatch[]>();
  for (const b of SCORE_BUCKETS) byBucket.set(b, []);
  for (const w of watches) {
    byBucket.get(scoreBucket(w.initialScore))!.push(w);
  }

  return SCORE_BUCKETS.map((bucket) => {
    const group = byBucket.get(bucket)!;
    const r = resolvedStats(group);
    return {
      bucket,
      entries: group.length,
      resolved: r.resolved,
      wins: r.wins,
      winRate: r.winRate,
      avgMfePct: avgMfe(group),
      avgMaePct: avgMae(group),
    };
  });
}

/**
 * Per-factor breakdown over RESOLVED entries only. Factor names are
 * collected dynamically from initialBreakdown.checks[].name. For each
 * factor it splits resolved entries into pass/fail by that check's
 * `passed` flag and computes the win-rate of each side; `edge` is the
 * pass-side win-rate minus the fail-side win-rate.
 */
export function computeByFactor(watches: StatWatch[]): FactorRow[] {
  const acc = new Map<
    string,
    {
      passResolved: number;
      passWins: number;
      failResolved: number;
      failWins: number;
    }
  >();

  for (const w of watches) {
    if (!isResolved(w)) continue;
    const won = isWin(w);
    for (const check of w.checks ?? []) {
      if (!check || typeof check.name !== 'string') continue;
      let entry = acc.get(check.name);
      if (!entry) {
        entry = { passResolved: 0, passWins: 0, failResolved: 0, failWins: 0 };
        acc.set(check.name, entry);
      }
      if (check.passed) {
        entry.passResolved += 1;
        if (won) entry.passWins += 1;
      } else {
        entry.failResolved += 1;
        if (won) entry.failWins += 1;
      }
    }
  }

  const rows: FactorRow[] = [];
  for (const [factor, e] of acc) {
    const passWinRate = e.passResolved
      ? (e.passWins / e.passResolved) * 100
      : 0;
    const failWinRate = e.failResolved
      ? (e.failWins / e.failResolved) * 100
      : 0;
    rows.push({
      factor,
      passResolved: e.passResolved,
      passWins: e.passWins,
      passWinRate: round2(passWinRate),
      failResolved: e.failResolved,
      failWins: e.failWins,
      failWinRate: round2(failWinRate),
      edge: round2(passWinRate - failWinRate),
    });
  }

  // Deterministic order: biggest edge first, then factor name.
  rows.sort((a, b) => b.edge - a.edge || a.factor.localeCompare(b.factor));
  return rows;
}

/**
 * Per-day breakdown: one row per IST calendar date that had any watch
 * entries. Watches are bucketed by the IST date of `initialAt`.
 * `realizedNetPnl` sums the net P&L of CLOSED paper trades linked (via
 * paperTradeId) to that day's watch entries. Sorted date-descending.
 */
export function computeByDay(
  watches: StatWatch[],
  trades: StatTrade[],
): DayRow[] {
  const tradeById = new Map(trades.map((t) => [t.id, t]));

  // date -> watch entries initialised that day
  const watchesByDay = new Map<string, StatWatch[]>();
  for (const w of watches) {
    const key = istDateKey(w.initialAt);
    const bucket = watchesByDay.get(key);
    if (bucket) bucket.push(w);
    else watchesByDay.set(key, [w]);
  }

  const rows: DayRow[] = [];
  for (const [date, group] of watchesByDay) {
    const r = resolvedStats(group);

    let realizedNetPnl = 0;
    for (const w of group) {
      if (!w.paperTradeId) continue;
      const t = tradeById.get(w.paperTradeId);
      if (t && isClosed(t)) realizedNetPnl += netOf(t);
    }

    rows.push({
      date,
      entries: group.length,
      resolved: r.resolved,
      wins: r.wins,
      winRate: r.winRate,
      executed: group.filter((w) => w.paperTradeId != null).length,
      realizedNetPnl: round2(realizedNetPnl),
    });
  }

  // Most recent day first.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}
