import { SECTOR_INDICES } from '@td/shared';
import { INFO_BAND_ATR, judgeInfoItem, type DailyBar } from '../../signal-intake/domain/info-outcome';
import type { Claim } from './reading.types';

/**
 * Night review of the reader's claims (spec §5.5): did what the channel said come true? Builds each
 * channel's information accuracy. Thresholds are fixed here before the first score; daily and 15m bars
 * only (never 1m).
 *
 * - DIRECTION on an instrument (BULL/BEAR): the existing CHANNEL_INFO scorer (`judgeInfoItem`) on the
 *   subject's daily bars — close-to-close vs ±0.3×ATR14 (× √n for a DAYS / WEEKS horizon).
 * - DIRECTION on MARKET (BULL/BEAR): the same scorer on NIFTY. Inside the band → NOT_SCORED "flat".
 * - CAUTION: RIGHT if NIFTY's rest-of-session range ≥ its 20-day median daily range, or NIFTY fell
 *   ≥ 0.3×ATR14 from the post to the close; else WRONG.
 * - RELATIVE_BREADTH ("index strong, stocks weak"): RIGHT if NIFTY rose from the post to the close and
 *   the 15:25 IST advance/decline ratio is < 1; WRONG otherwise.
 * - SECTOR (BULL/BEAR): the sector index's daily close vs ±0.3×ATR14 (the same scorer).
 * - FLOW, GAP, OTHER: NOT_SCORED (stored, not scored in v1).
 * Missing data is NOT_SCORED with the reason — never a guess.
 */

export type ClaimScoreStatus = 'RIGHT' | 'WRONG' | 'NOT_SCORED';

export interface ClaimScore {
  status: ClaimScoreStatus;
  why: string;
}

export interface ClaimScoreCtx {
  niftyDaily: DailyBar[];
  /** Daily bars of the claim's subject (instrument / sector index); null when it could not be resolved or fetched. */
  subjectDaily: DailyBar[] | null;
  /** IST 'YYYY-MM-DD' of the NSE session the post is judged on (the next session for a post after the close). */
  postSession: string;
  /** NIFTY level at the post: last completed 15m close (the previous daily close for a pre-open post). */
  postClose: number | null;
  /** NIFTY close of postSession. */
  sessionClose: number | null;
  /** NIFTY high − low from the post to the close (15m bars; the day's range for a pre-open post). */
  sessionRange: number | null;
  /** Median daily NIFTY range of the 20 sessions before postSession. */
  medianRange20: number | null;
  /** NIFTY ATR14 of the sessions before postSession. */
  atr14: number | null;
  /** Advance/decline ratio at 15:25 IST of postSession. */
  adAtClose: number | null;
}

/** A 15-minute bar; `ts` = bar start (ms). */
export interface IntradayBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * PENDING = the claim cannot be judged YET: its horizon is not over, or the bars it needs are empty / do not
 * reach the post's session ("data unavailable", e.g. a broker hiccup at 18:30). The night job keeps the row
 * open and retries the next night; {@link scoreClaim} reports it NOT_SCORED.
 */
export type ClaimEvaluation = { status: ClaimScoreStatus | 'PENDING'; why: string };

export const CLAIM_BAND_ATR = INFO_BAND_ATR;
const ATR_N = 14;
const MEDIAN_N = 20;
const BAR_15M_MS = 15 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
const NSE_OPEN_MIN = 9 * 60 + 15;
const NSE_CLOSE_MIN = 15 * 60 + 30;

const r2 = (x: number) => Math.round(x * 100) / 100;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${r2(x)}`;
const istYmd = (d: Date | number) => new Date(+d + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinutes = (d: Date) => {
  const i = new Date(d.getTime() + IST_OFFSET_MS);
  return i.getUTCHours() * 60 + i.getUTCMinutes();
};
const notScored = (why: string): ClaimEvaluation => ({ status: 'NOT_SCORED', why });
export const DATA_UNAVAILABLE = 'data unavailable';
const unavailable = (what: string): ClaimEvaluation => ({ status: 'PENDING', why: `${DATA_UNAVAILABLE}: ${what}` });

/** One claim's score; a horizon not yet over or missing data is NOT_SCORED ("pending" / "data unavailable"). */
export function scoreClaim(c: Claim, ctx: ClaimScoreCtx): ClaimScore {
  const e = evaluateClaim(c, ctx);
  return e.status === 'PENDING' ? { status: 'NOT_SCORED', why: e.why } : { status: e.status, why: e.why };
}

/** As {@link scoreClaim}, but keeps PENDING apart so the night job can wait (horizon not over, data unavailable). */
export function evaluateClaim(c: Claim, ctx: ClaimScoreCtx): ClaimEvaluation {
  switch (c.claimType) {
    case 'DIRECTION':
      if (c.subject === 'MARKET') return direction(c, ctx.niftyDaily, 'NIFTY', ctx.postSession);
      return ctx.subjectDaily?.length ? direction(c, ctx.subjectDaily, c.subject, ctx.postSession) : unavailable(`no daily bars for ${c.subject}`);
    case 'SECTOR':
      return ctx.subjectDaily?.length ? direction(c, ctx.subjectDaily, c.subject, ctx.postSession) : unavailable(`no sector index bars for ${c.subject}`);
    case 'CAUTION':
      return caution(ctx);
    case 'RELATIVE_BREADTH':
      return relativeBreadth(ctx);
    default:
      return notScored(`${c.claimType} claims are not scored`);
  }
}

function direction(c: Claim, bars: readonly DailyBar[], label: string, postSession: string): ClaimEvaluation {
  if (c.bias !== 'BULL' && c.bias !== 'BEAR') return notScored(`no direction (bias ${c.bias})`);
  const o = judgeInfoItem(
    { underlying: label, bias: c.bias, levels: [], targetLevel: null, oi: null, condition: null, horizon: c.horizon },
    bars,
    { day: postSession, afterClose: false },
  );
  if (o.status === 'PENDING') return { status: 'PENDING', why: `pending: ${c.horizon} horizon from ${postSession} not over` };
  if (o.ret === null || o.band === null || o.status === 'NO_DATA' || o.status === 'NO_BIAS' || o.status === 'NOT_JUDGED_MONTHS') {
    return unavailable(`no ${label} daily bars / ATR around ${postSession}`);
  }
  const why = `${label} ${signed(o.ret)} close-to-close (${o.baseClose} → ${o.judgedClose}, ${o.session}) vs band ±${o.band}`;
  if (o.status === 'FLAT') return notScored(`flat: ${why}`);
  return { status: o.status === 'RIGHT' ? 'RIGHT' : 'WRONG', why: `${c.bias}: ${why}` };
}

function caution(ctx: ClaimScoreCtx): ClaimEvaluation {
  const { sessionRange, medianRange20, postClose, sessionClose, atr14 } = ctx;
  const canRange = sessionRange !== null && medianRange20 !== null;
  const canFall = postClose !== null && sessionClose !== null && atr14 !== null;
  if (canRange && sessionRange >= medianRange20) {
    return { status: 'RIGHT', why: `wide range: NIFTY rest-of-session range ${r2(sessionRange)} ≥ 20-day median ${r2(medianRange20)}` };
  }
  if (canFall && postClose - sessionClose >= CLAIM_BAND_ATR * atr14) {
    return { status: 'RIGHT', why: `NIFTY fell ${r2(postClose - sessionClose)} (${postClose} → ${sessionClose}) ≥ 0.3×ATR14 ${r2(CLAIM_BAND_ATR * atr14)}` };
  }
  if (!canRange || !canFall) return unavailable('NIFTY 15m range / post level / ATR14 to check the caution');
  return {
    status: 'WRONG',
    why: `calm: range ${r2(sessionRange as number)} < median ${r2(medianRange20 as number)}, NIFTY ${signed((sessionClose as number) - (postClose as number))} from the post (fall < 0.3×ATR14 ${r2(CLAIM_BAND_ATR * (atr14 as number))})`,
  };
}

function relativeBreadth(ctx: ClaimScoreCtx): ClaimEvaluation {
  const { postClose, sessionClose, adAtClose } = ctx;
  // A missing 15:25 A/D never comes back (it is taken live), so it is not waited for.
  if (adAtClose === null) return notScored('no 15:25 IST advance/decline for the session');
  if (postClose === null || sessionClose === null) return unavailable('NIFTY 15m post level / session close');
  const ret = sessionClose - postClose;
  const pct = (ret / postClose) * 100;
  const why = `NIFTY ${signed(ret)} (${signed(pct)}%) from the post to the close, A/D ${adAtClose} at 15:25 IST`;
  return { status: ret > 0 && adAtClose < 1 ? 'RIGHT' : 'WRONG', why };
}

/**
 * The NSE session a post is judged on, from NIFTY's daily bar days: the post's own day when it came before
 * the 15:30 close, else the next session in the bars. Null while that session is not in the bars or still open.
 */
export function postSessionOf(postedAt: Date, niftyDays: readonly string[], now: Date): string | null {
  const day = istYmd(postedAt);
  const beforeClose = istMinutes(postedAt) < NSE_CLOSE_MIN;
  const session = [...niftyDays].sort().find((d) => d > day || (d === day && beforeClose)) ?? null;
  if (!session) return null;
  if (session > istYmd(now) || (session === istYmd(now) && istMinutes(now) < NSE_CLOSE_MIN)) return null;
  return session;
}

/** NIFTY numbers around one post (the market rules' context). */
export function marketContext(
  niftyDaily: readonly DailyBar[],
  nifty15m: readonly IntradayBar[],
  postedAt: Date,
  postSession: string,
): Pick<ClaimScoreCtx, 'postClose' | 'sessionClose' | 'sessionRange' | 'medianRange20' | 'atr14'> {
  const daily = [...niftyDaily].filter((b) => Number.isFinite(b.close) && b.close > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const sessionBar = daily.find((b) => b.day === postSession) ?? null;
  const prior = daily.filter((b) => b.day < postSession);
  const prevClose = prior.length ? prior[prior.length - 1].close : null;

  let atr14: number | null = null;
  if (prior.length > ATR_N) {
    let sum = 0;
    for (let i = prior.length - ATR_N; i < prior.length; i++) {
      const b = prior[i];
      const pc = prior[i - 1].close;
      sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    atr14 = r2(sum / ATR_N);
  }
  let medianRange20: number | null = null;
  if (prior.length >= MEDIAN_N) {
    const ranges = prior.slice(-MEDIAN_N).map((b) => b.high - b.low).sort((a, b) => a - b);
    medianRange20 = r2((ranges[MEDIAN_N / 2 - 1] + ranges[MEDIAN_N / 2]) / 2);
  }

  const preOpen = istYmd(postedAt) < postSession || istMinutes(postedAt) < NSE_OPEN_MIN;
  let postClose: number | null;
  let sessionRange: number | null;
  if (preOpen) {
    postClose = prevClose;
    sessionRange = sessionBar ? r2(sessionBar.high - sessionBar.low) : null;
  } else {
    const bars = nifty15m.filter((b) => istYmd(b.ts) === postSession).sort((a, b) => a.ts - b.ts);
    const t = postedAt.getTime();
    const done = bars.filter((b) => b.ts + BAR_15M_MS <= t);
    postClose = done.length ? done[done.length - 1].close : bars.length && bars[0].ts <= t ? bars[0].open : null;
    const rest = bars.filter((b) => b.ts + BAR_15M_MS > t);
    sessionRange = rest.length ? r2(Math.max(...rest.map((b) => b.high)) - Math.min(...rest.map((b) => b.low))) : null;
  }
  return { postClose, sessionClose: sessionBar?.close ?? null, sessionRange, medianRange20, atr14 };
}

const SECTOR_REFS: ReadonlyMap<string, { exchange: string; token: string }> = (() => {
  const m = new Map<string, { exchange: string; token: string }>();
  for (const s of Object.values(SECTOR_INDICES)) {
    const ref = { exchange: s.exchange, token: s.token };
    const short = s.symbol.replace(/^NIFTY /, '');
    for (const k of [short, short.replace(/ /g, ''), s.sector.toUpperCase(), s.sector.toUpperCase().replace(/ /g, '')]) if (!m.has(k)) m.set(k, ref);
  }
  return m;
})();

/** The NSE sector index for a reader sector name (BANK, IT, PSU BANK …); null when none. */
export function sectorRefOf(subject: string): { exchange: string; token: string } | null {
  return SECTOR_REFS.get(subject.trim().toUpperCase()) ?? null;
}
