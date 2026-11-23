import { REENTRY_UNIVERSE, REENTRY_WATCH } from './reentry-rules';

/**
 * RE-ENTRY WATCH — LIVE GATE (docs/superpowers/specs/2026-11-23-reentry-live-design.md §3, §4.2, §6a). Pure.
 *
 * Decides whether ONE re-entry SIGNAL (already through the re-entry rules) may be sent as a REAL order. It
 * returns `{ live: true }` only when every limit allows it; anything else is `{ live: false, limit, detail }`
 * and the caller paper-trades the signal and stores `limit` + `detail` on the decision row.
 *
 * Safety: any input that is null, NaN, negative or otherwise unreadable ⇒ UNKNOWN_INPUT (never live).
 * Counts must come from the DATABASE (in-flight orders included), never from in-memory maps — the gate only
 * compares; it cannot know where a number came from.
 *
 * Check order (the first that blocks is the stored limit): MODE, SOURCE, JUDGE, UNKNOWN_INPUT, MAX_PER_TRADE,
 * MAX_PER_DAY, LOSS_STOP, DAILY_LOSS_STOP, UNDERLYING_OPEN, TIME_WINDOW.
 * Size / risk / funds (RISK_OVER_LIMIT, NO_FUNDS, NO_SIZE) are decided after the gate by reentry-live-size.ts.
 */
export type ReentryLiveLimit =
  | 'MODE'
  | 'SOURCE'
  | 'JUDGE'
  | 'MAX_PER_TRADE'
  | 'MAX_PER_DAY'
  | 'LOSS_STOP'
  | 'DAILY_LOSS_STOP'
  | 'TIME_WINDOW'
  | 'UNDERLYING_OPEN'
  | 'RISK_OVER_LIMIT'
  | 'NO_FUNDS'
  | 'NO_SIZE'
  | 'UNKNOWN_INPUT';

export interface ReentryLiveLimits {
  /** §6a.1: fixed ₹ cap on (entry − SL) × qty per order (REENTRY_LIVE_RISK_RUPEES, default 2000). */
  riskRupees: number;
  /** §3 #5 / §6a.3a: re-entries (live + paper fallback) per real-source watch (default 4). */
  maxPerTrade: number;
  /** §3 #6 / §6a.3c: live re-entry orders per IST day (default 6). */
  maxPerDay: number;
  /** §3 #7: losing live re-entries per IST day before the stop (default 3). */
  maxLosses: number;
  /** "HH:MM" IST, inclusive start for every venue (default 09:45). */
  fromIst: string;
  /** "HH:MM" IST, exclusive end for NSE/BSE (default 15:00). */
  nseUntilIst: string;
  /** "HH:MM" IST, exclusive end for MCX (default 23:00). */
  mcxUntilIst: string;
  /** Never in the venue's last N minutes (the existing re-entry rule: 30). */
  noEntryLastMin: number;
}

export const REENTRY_LIVE_DEFAULTS: Readonly<ReentryLiveLimits> = Object.freeze({
  riskRupees: 2000,
  maxPerTrade: 4,
  maxPerDay: 6,
  maxLosses: 3,
  fromIst: '09:45',
  nseUntilIst: '15:00',
  mcxUntilIst: '23:00',
  noEntryLastMin: REENTRY_WATCH.noEntryLastMin,
});

/**
 * Upper bounds on the env values: a typo (60 instead of 6) must not widen real-money exposure — anything above
 * falls back to the default (reported). 0 is allowed for the caps (= never live), which is the safe direction.
 */
const MAX = Object.freeze({ riskRupees: 10_000, maxPerTrade: 10, maxPerDay: 20, maxLosses: 10 });

/** "HH:MM" → minutes after midnight, or null when not a valid clock time. */
export function hhmmToMin(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

const minToHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Minutes after IST midnight of an instant. */
export function istMinuteOf(at: Date): number {
  const m = Math.floor((at.getTime() + 330 * 60_000) / 60_000) % 1440;
  return m < 0 ? m + 1440 : m;
}

/**
 * The live limits from env (§4.1, §6a.1). Never throws. A bad value (not a number, out of range, not HH:MM,
 * or an end not after the start) = the default, with a line pushed to `problems` (the caller logs it).
 */
export function reentryLiveLimitsFrom(env: Record<string, string | undefined>, problems: string[] = []): ReentryLiveLimits {
  const d = REENTRY_LIVE_DEFAULTS;
  const num = (key: string, def: number, max: number, integer: boolean, min: number): number => {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === '') return def;
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) return n;
    problems.push(`${key}=${raw} is not ${integer ? 'an integer' : 'a number'} in ${min}..${max} — using ${def}`);
    return def;
  };
  const time = (key: string, def: string): string => {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === '') return def;
    const m = hhmmToMin(raw);
    if (m !== null) return minToHhmm(m);
    problems.push(`${key}=${raw} is not HH:MM — using ${def}`);
    return def;
  };
  const out: ReentryLiveLimits = {
    // risk must be > 0: a 0 cap would size nothing (paper), but a negative/NaN must never reach the sizing.
    riskRupees: num('REENTRY_LIVE_RISK_RUPEES', d.riskRupees, MAX.riskRupees, false, 1),
    maxPerTrade: num('REENTRY_LIVE_MAX_PER_TRADE', d.maxPerTrade, MAX.maxPerTrade, true, 0),
    maxPerDay: num('REENTRY_LIVE_MAX_PER_DAY', d.maxPerDay, MAX.maxPerDay, true, 0),
    maxLosses: num('REENTRY_LIVE_MAX_LOSSES', d.maxLosses, MAX.maxLosses, true, 0),
    fromIst: time('REENTRY_LIVE_FROM_IST', d.fromIst),
    nseUntilIst: time('REENTRY_LIVE_NSE_UNTIL_IST', d.nseUntilIst),
    mcxUntilIst: time('REENTRY_LIVE_MCX_UNTIL_IST', d.mcxUntilIst),
    noEntryLastMin: d.noEntryLastMin,
  };
  const from = hhmmToMin(out.fromIst)!;
  if (hhmmToMin(out.nseUntilIst)! <= from) {
    problems.push(`REENTRY_LIVE_NSE_UNTIL_IST ${out.nseUntilIst} is not after REENTRY_LIVE_FROM_IST ${out.fromIst} — using ${d.fromIst}–${d.nseUntilIst}`);
    out.fromIst = d.fromIst;
    out.nseUntilIst = d.nseUntilIst;
  }
  if (hhmmToMin(out.mcxUntilIst)! <= hhmmToMin(out.fromIst)!) {
    problems.push(`REENTRY_LIVE_MCX_UNTIL_IST ${out.mcxUntilIst} is not after REENTRY_LIVE_FROM_IST ${out.fromIst} — using ${d.fromIst}–${d.mcxUntilIst}`);
    out.fromIst = d.fromIst;
    out.mcxUntilIst = d.mcxUntilIst;
  }
  return out;
}

export interface LiveGateInput {
  /** REENTRY_WATCH mode; only 'live' can go live. */
  mode: 'off' | 'paper' | 'live';
  /** The watch's exit: REAL (trade_trackers) or a PAPER trade. Only REAL can go live (§3 #1). */
  source: 'REAL' | 'PAPER';
  /** EntryJudgeService result: live only with mode 'on', ok, decision 'ENTER' (§6a.7). */
  judge: { mode: string; decision: string | null; ok: boolean };
  /** Re-entries of this watch so far (live + paper fallback, in-flight included), from the DB. */
  reentriesOfWatch: number | null;
  /** Live re-entry orders today (IST), in-flight included, from the DB. */
  liveToday: number | null;
  /** Closed losing live re-entries today (IST, §6a.5), from the DB. */
  liveLossesToday: number | null;
  /** The signal trader's shared daily real-money stop reached (§6a.4). */
  dailyLossStopHit: boolean | null;
  /** A real position (minis included) / in-flight live order / open re-entry paper trade on this underlying. */
  underlyingOpenOrInFlight: boolean | null;
  venue: 'NSE' | 'BSE' | 'MCX';
  underlying: string;
  /** The real instant of the decision (a normal Date); the gate reads its IST wall clock. */
  atIst: Date;
  /** The venue's close today, "HH:MM" IST (null = unknown ⇒ UNKNOWN_INPUT). */
  venueCloseIst: string | null;
}

export type LiveGateResult = { live: true } | { live: false; limit: ReentryLiveLimit; detail: string };

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** May this re-entry SIGNAL be sent as a real order? Pure; see the file header for the order of checks. */
export function liveGate(i: LiveGateInput, limits: ReentryLiveLimits): LiveGateResult {
  const no = (limit: ReentryLiveLimit, detail: string): LiveGateResult => ({ live: false, limit, detail });

  if (i?.mode !== 'live') return no('MODE', `REENTRY_WATCH=${i?.mode ?? 'unknown'} (not live)`);
  if (i.source !== 'REAL') return no('SOURCE', `source ${i.source ?? 'unknown'} — only real exits re-enter live`);
  const j = i.judge;
  if (!j || j.ok !== true || j.mode !== 'on' || j.decision !== 'ENTER') {
    const what = !j ? 'no judge result' : j.ok !== true ? `judge call failed (mode ${j.mode})` : j.mode !== 'on' ? `judge mode ${j.mode} (not on)` : `judge ${j.decision ?? 'no decision'} (not ENTER)`;
    return no('JUDGE', what);
  }

  // Every remaining input must be readable — anything else is paper.
  const unknown: string[] = [];
  if (!isCount(i.reentriesOfWatch)) unknown.push(`reentriesOfWatch=${i.reentriesOfWatch}`);
  if (!isCount(i.liveToday)) unknown.push(`liveToday=${i.liveToday}`);
  if (!isCount(i.liveLossesToday)) unknown.push(`liveLossesToday=${i.liveLossesToday}`);
  if (typeof i.dailyLossStopHit !== 'boolean') unknown.push(`dailyLossStopHit=${i.dailyLossStopHit}`);
  if (typeof i.underlyingOpenOrInFlight !== 'boolean') unknown.push(`underlyingOpenOrInFlight=${i.underlyingOpenOrInFlight}`);
  if (i.venue !== 'NSE' && i.venue !== 'BSE' && i.venue !== 'MCX') unknown.push(`venue=${i.venue}`);
  const und = String(i.underlying ?? '').trim().toUpperCase();
  if (!REENTRY_UNIVERSE.includes(und)) unknown.push(`underlying=${i.underlying} (not in the watch universe)`);
  if (!(i.atIst instanceof Date) || !Number.isFinite(i.atIst.getTime())) unknown.push(`atIst=${String(i.atIst)}`);
  const close = hhmmToMin(i.venueCloseIst);
  if (close === null) unknown.push(`venueCloseIst=${i.venueCloseIst}`);
  const from = hhmmToMin(limits?.fromIst);
  const until = hhmmToMin(i.venue === 'MCX' ? limits?.mcxUntilIst : limits?.nseUntilIst);
  if (
    !limits ||
    from === null ||
    until === null ||
    !isCount(limits.maxPerTrade) ||
    !isCount(limits.maxPerDay) ||
    !isCount(limits.maxLosses) ||
    !isCount(limits.noEntryLastMin) ||
    !(typeof limits.riskRupees === 'number' && limits.riskRupees > 0 && Number.isFinite(limits.riskRupees))
  ) {
    unknown.push('limits unreadable');
  }
  if (unknown.length > 0) return no('UNKNOWN_INPUT', unknown.join(', '));

  const perWatch = i.reentriesOfWatch as number;
  const today = i.liveToday as number;
  const losses = i.liveLossesToday as number;
  if (perWatch >= limits.maxPerTrade) return no('MAX_PER_TRADE', `MAX_PER_TRADE ${perWatch}/${limits.maxPerTrade}`);
  if (today >= limits.maxPerDay) return no('MAX_PER_DAY', `MAX_PER_DAY ${today}/${limits.maxPerDay}`);
  if (losses >= limits.maxLosses) return no('LOSS_STOP', `LOSS_STOP ${losses}/${limits.maxLosses} losing live re-entries today`);
  if (i.dailyLossStopHit) return no('DAILY_LOSS_STOP', 'daily real-money loss stop (SIGNAL_DAILY_LOSS_STOP) reached');
  if (i.underlyingOpenOrInFlight) return no('UNDERLYING_OPEN', `${und} has an open position or an in-flight order`);

  const at = istMinuteOf(i.atIst);
  const window = `${minToHhmm(from!)}–${minToHhmm(until!)}`;
  if (at < from!) return no('TIME_WINDOW', `${minToHhmm(at)} IST is before ${minToHhmm(from!)} (${i.venue} live window ${window})`);
  if (at >= until!) return no('TIME_WINDOW', `${minToHhmm(at)} IST is not before ${minToHhmm(until!)} (${i.venue} live window ${window})`);
  const toClose = close! - at;
  if (toClose < limits.noEntryLastMin) {
    return no('TIME_WINDOW', `${minToHhmm(at)} IST is ${toClose} min to the ${i.venue} close ${minToHhmm(close!)} (none in the last ${limits.noEntryLastMin})`);
  }
  return { live: true };
}
