import type { SessionWindow } from '../../trade-sentinel/market-sessions';

/**
 * Inputs health (2026-11-04, spec analysis-inputs-and-judge goal 5). GrW's dominant bug shape is
 * "correct code, inert, silent": on 2026-11-04 GOLD had zero 1m bars stored all day, no option chain
 * in oi_snapshots, and the entry engine's news input was NO_DATA on 58/113 checks (BANKNIFTY 25/25) —
 * and nobody noticed until the night. This checker turns each of those into a same-day problem. Pure:
 * the service builds the snapshot from the database and owns the Telegram send + the per-day dedupe.
 */

export type ProblemKind = 'NO_BARS' | 'NO_CHAIN' | 'NEWS_SILENT' | 'ENGINE_NEWS_EMPTY';

/** Thresholds (spec §5 leaves them to the implementation). Minutes, except the share. */
export const INPUTS_HEALTH = Object.freeze({
  /** No 1m bar on any of the underlying's own lines (spot / near-month future / cash) for this long. */
  barsStaleMin: 10,
  /** No oi_snapshots row on any of the underlying's options for this long (optionable only). */
  chainStaleMin: 30,
  /** No news_impacts row analysed for this long while NSE is open. */
  newsSilentMin: 60,
  /** The entry engine's news reading NO_DATA on more than this share of today's checks... */
  engineNoDataShare: 0.8,
  /** ...once it has made at least this many checks (one NO_DATA at 09:20 is not a dead pipeline). */
  engineMinChecks: 6,
});

/** The venue whose session (and holidays) an underlying keeps: index options on NFO trade NSE hours, BFO BSE hours. */
export function sessionVenue(exchange: string): string {
  const ex = String(exchange ?? '').trim().toUpperCase();
  if (ex === 'NFO') return 'NSE';
  if (ex === 'BFO') return 'BSE';
  return ex || 'NSE';
}

export interface WatchedUnderlying {
  /** Master name, upper-case (NIFTY, GOLD, RELIANCE). */
  name: string;
  /** The exchange its derivatives trade on (NFO / BFO / MCX) or NSE for cash; the session follows {@link sessionVenue}. */
  exchange: string;
  /** Why it is watched (ENGINE / LINE / POSITION) — in the message, so the owner knows what is blind. */
  why: readonly string[];
  /** The refs whose bars count, as `EXCHANGE:token`; empty = none resolved from the master. */
  barRefs: readonly string[];
  lastBarAt: Date | null;
  /** True when the master lists an active CE/PE on it. */
  optionable: boolean;
  lastChainAt: Date | null;
}

export interface EngineNewsTally {
  underlying: string;
  /** Today's entry_engine_decisions rows for it. */
  checks: number;
  /** Of which the news reason was `news: NO_DATA — …`. */
  newsNoData: number;
}

export interface InputsSnapshot {
  now: Date;
  underlyings: readonly WatchedUnderlying[];
  /** Newest news_impacts.analysed_at, or null when the table is empty. */
  lastNewsAt: Date | null;
  engineNews: readonly EngineNewsTally[];
}

export interface Problem {
  kind: ProblemKind;
  /** Upper-case underlying name, or 'NEWS' for the pipeline-wide check. */
  underlying: string;
  message: string;
}

/** The session clock the checker needs (market-hub SessionClock satisfies it). */
export interface HealthClock {
  isOpen(exchange: string, at: Date): boolean;
  tradingWindow(exchange: string, at: Date): SessionWindow | null;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const MIN = 60_000;

/** UTC instant of `at`'s IST midnight plus `minutes`. */
function istDayAt(at: Date, minutes: number): Date {
  const ymd = new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS + minutes * MIN);
}

/** 'HH:MM' IST. */
export function istHm(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** Today's session open of `venue`, when it is open now; else null (nothing is checked outside a session). */
function openSince(clock: HealthClock, venue: string, now: Date): Date | null {
  if (!clock.isOpen(venue, now)) return null;
  const w = clock.tradingWindow(venue, now);
  return w ? istDayAt(now, w.openMin) : null;
}

/**
 * Minutes the input has been missing: from the later of its last datum and today's session open (an
 * input cannot be late before the session starts — yesterday's last bar does not count against 09:16).
 */
function staleMinutes(last: Date | null, sessionOpen: Date, now: Date): number {
  const from = last && last.getTime() > sessionOpen.getTime() ? last : sessionOpen;
  return (now.getTime() - from.getTime()) / MIN;
}

const lastText = (last: Date | null, now: Date): string => {
  if (!last) return 'none ever stored';
  const today = istDayAt(now, 0).getTime();
  return last.getTime() >= today ? `last ${istHm(last)} IST` : `last ${new Date(last.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
};

/**
 * The problems standing at `snapshot.now`. Each underlying is judged only while ITS venue is open
 * (NSE 09:15–15:30, MCX 09:00–23:30/23:55, holidays closed — the clock decides); news only while NSE
 * is open. Never throws on odd data.
 */
export function checkInputs(snapshot: InputsSnapshot, clock: HealthClock): Problem[] {
  const { now } = snapshot;
  const out: Problem[] = [];
  const t = INPUTS_HEALTH;

  for (const u of snapshot.underlyings) {
    const venue = sessionVenue(u.exchange);
    const open = openSince(clock, venue, now);
    if (!open) continue;
    const name = u.name.toUpperCase();
    const why = u.why.length ? ` [${u.why.join('+')}]` : '';

    const barGap = staleMinutes(u.lastBarAt, open, now);
    if (barGap > t.barsStaleMin) {
      const refs = u.barRefs.length ? u.barRefs.join(', ') : 'no spot / future / cash line found in the master';
      out.push({
        kind: 'NO_BARS',
        underlying: name,
        message: `${name}${why}: no 1m bars in candles_1m for ${Math.round(barGap)} min while ${venue} is open (${lastText(u.lastBarAt, now)}; lines: ${refs}).`,
      });
    }

    if (u.optionable) {
      const chainGap = staleMinutes(u.lastChainAt, open, now);
      if (chainGap > t.chainStaleMin) {
        out.push({
          kind: 'NO_CHAIN',
          underlying: name,
          message: `${name}${why}: no option chain in oi_snapshots for ${Math.round(chainGap)} min while ${venue} is open (${lastText(u.lastChainAt, now)}).`,
        });
      }
    }
  }

  const nseOpen = openSince(clock, 'NSE', now);
  if (nseOpen) {
    const gap = staleMinutes(snapshot.lastNewsAt, nseOpen, now);
    if (gap > t.newsSilentMin) {
      out.push({
        kind: 'NEWS_SILENT',
        underlying: 'NEWS',
        message: `News pipeline silent: no news_impacts analysed for ${Math.round(gap)} min in market hours (${lastText(snapshot.lastNewsAt, now)}).`,
      });
    }
  }

  const exchangeOf = new Map(snapshot.underlyings.map((u) => [u.name.toUpperCase(), u.exchange] as const));
  for (const e of snapshot.engineNews) {
    const name = e.underlying.toUpperCase();
    const venue = sessionVenue(exchangeOf.get(name) ?? 'NSE');
    if (!openSince(clock, venue, now)) continue;
    if (e.checks < t.engineMinChecks || e.checks <= 0) continue;
    const share = e.newsNoData / e.checks;
    if (share > t.engineNoDataShare) {
      out.push({
        kind: 'ENGINE_NEWS_EMPTY',
        underlying: name,
        message: `${name}: entry engine news input NO_DATA on ${e.newsNoData}/${e.checks} checks today (${Math.round(share * 100)}%) — it is deciding without news.`,
      });
    }
  }

  return out;
}
