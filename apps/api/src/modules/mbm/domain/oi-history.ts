// Pure pieces of the NIFTY past-OI backfill (OiHistoryBackfillService): config, the no-run window,
// NSE-session arithmetic for request windows, and the bounded contract selection. No I/O.
import type { NseCalendar } from './bar-window';
import { atmStrike } from './chain-snapshot';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
/** No backfill on an NSE trading day from 08:30 IST (the pre-open jobs share the session) to 15:45 IST. */
export const BLACKOUT_FROM_MIN = 8 * 60 + 30;
export const BLACKOUT_TO_MIN = 15 * 60 + 45;

/** Finest first: the backfill keeps the first one the probe gets rows for. */
export const PROBE_INTERVALS = ['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE'] as const;
/** Window sizes (calendar days) the chunk probe tries, widest first, each capped at the configured max. */
export const CHUNK_CANDIDATES_DAYS = [30, 15, 7, 1] as const;
/** Backward walk ends after this many consecutive empty windows that contained an NSE session. */
export const EMPTY_STREAK_STOP = 2;

export type OiKind = 'FUT' | 'CE' | 'PE';

export interface OiContract {
  token: string;
  symbol: string;
  kind: OiKind;
  /** YYYY-MM-DD */
  expiry: string;
  strike: number | null;
}

export interface OiHistoryConfig {
  /** OI_BACKFILL_ENABLED (default on). */
  enabled: boolean;
  /** OI_BACKFILL_MAX_CALLS: historical calls per run, probes included (default 2000). */
  maxCalls: number;
  /** OI_BACKFILL_STRIKES: listed strikes kept beyond each end of the spot range (default 10). */
  strikesAround: number;
  /** OI_BACKFILL_EXPIRY_DAYS: option expiries up to this many days ahead (default 100). */
  expiryHorizonDays: number;
  /** OI_BACKFILL_LOOKBACK_DAYS: oldest point the walk asks for (default 365). */
  lookbackDays: number;
  /**
   * OI_BACKFILL_SPOT_DAYS: the NIFTY high/low window that sets the strike band (default 120 — about the
   * longest a live, non-quarterly NIFTY contract has been listed; a year of range would triple the set).
   */
  spotRangeDays: number;
  /** OI_BACKFILL_MAX_CONTRACTS: hard cap on the contract set, nearest-ATM first (default 1500). */
  maxContracts: number;
  /** OI_BACKFILL_CHUNK_DAYS: widest request window the chunk probe tries (default 30). */
  maxChunkDays: number;
}

const int = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(String(raw ?? '').trim());
  return raw == null || String(raw).trim() === '' || !Number.isFinite(n) ? dflt : Math.min(max, Math.max(min, Math.floor(n)));
};

export function parseOiHistoryConfig(env: NodeJS.ProcessEnv): OiHistoryConfig {
  const flag = (env.OI_BACKFILL_ENABLED ?? '').trim().toLowerCase();
  return {
    enabled: !['off', 'false', '0', 'no'].includes(flag),
    maxCalls: int(env.OI_BACKFILL_MAX_CALLS, 2000, 1, 20_000),
    strikesAround: int(env.OI_BACKFILL_STRIKES, 10, 0, 60),
    expiryHorizonDays: int(env.OI_BACKFILL_EXPIRY_DAYS, 100, 1, 1000),
    lookbackDays: int(env.OI_BACKFILL_LOOKBACK_DAYS, 365, 1, 2000),
    spotRangeDays: int(env.OI_BACKFILL_SPOT_DAYS, 120, 1, 2000),
    maxContracts: int(env.OI_BACKFILL_MAX_CONTRACTS, 1500, 1, 20_000),
    maxChunkDays: int(env.OI_BACKFILL_CHUNK_DAYS, 30, 1, 100),
  };
}

const istMinutes = (at: Date): number => {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** IST calendar day (YYYY-MM-DD) of an instant. */
export const istYmd = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The instant `min` minutes after IST midnight of `ymd`. */
const istAt = (ymd: string, min: number): Date => new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_OFFSET_MS + min * 60_000);

/** True when the backfill must not run: an NSE trading day (holiday-aware), 08:30–15:45 IST. */
export function inBlackout(cal: NseCalendar, now: Date): boolean {
  if (!cal.isTradingDay('NSE', now)) return false;
  const m = istMinutes(now);
  return m >= BLACKOUT_FROM_MIN && m < BLACKOUT_TO_MIN;
}

/** The NSE sessions (09:15–15:30 IST on trading days) that overlap [start, end), as IST days. */
export function sessionsIn(cal: NseCalendar, start: Date, end: Date): string[] {
  const out: string[] = [];
  if (end.getTime() <= start.getTime()) return out;
  for (let t = Date.parse(`${istYmd(start)}T12:00:00Z`); t <= end.getTime() + DAY_MS; t += DAY_MS) {
    const ymd = new Date(t).toISOString().slice(0, 10);
    const open = istAt(ymd, SESSION_OPEN_MIN);
    const close = istAt(ymd, SESSION_CLOSE_MIN);
    if (open.getTime() >= end.getTime() || close.getTime() <= start.getTime()) continue;
    if (cal.isTradingDay('NSE', istAt(ymd, 12 * 60))) out.push(ymd);
  }
  return out;
}

/** The newest NSE session that has closed by `now` (searched back up to 15 days), else null. */
export function lastCompletedSession(cal: NseCalendar, now: Date): { day: string; from: Date; to: Date } | null {
  for (let i = 0; i <= 15; i++) {
    const ymd = istYmd(new Date(now.getTime() - i * DAY_MS));
    const to = istAt(ymd, SESSION_CLOSE_MIN);
    if (to.getTime() > now.getTime()) continue;
    if (cal.isTradingDay('NSE', istAt(ymd, 12 * 60))) return { day: ymd, from: istAt(ymd, SESSION_OPEN_MIN), to };
  }
  return null;
}

/** Distinct IST days the points fall on. */
export function istDays(points: ReadonlyArray<{ ts: Date }>): number {
  return new Set(points.map((p) => istYmd(p.ts))).size;
}

/**
 * A wide window "covers" when it returned bars on all but at most one of the sessions in it: Angel did
 * not silently truncate it (either end). The probe contract must have been listed for the whole window.
 */
export function windowCovered(sessions: number, daysReturned: number): boolean {
  return sessions > 0 && daysReturned >= sessions - 1;
}

export interface SelectInput {
  futures: readonly OiContract[];
  /** expiry (YYYY-MM-DD) → that expiry's listed CE/PE contracts. */
  options: ReadonlyMap<string, readonly OiContract[]>;
  /** NIFTY spot low / high over OI_BACKFILL_SPOT_DAYS, and the latest close. */
  low: number;
  high: number;
  last: number;
  strikesAround: number;
  maxContracts: number;
}

export interface Selection {
  contracts: OiContract[];
  /** Options dropped by maxContracts (furthest from ATM, latest expiry first). */
  capped: number;
}

/**
 * Bounded contract set: every live NIFTY future, plus per option expiry the listed strikes from
 * (ATM at the period's LOW − n strikes) to (ATM at its HIGH + n strikes) — every strike that was within
 * ±n of the then-ATM at some point — both sides. Ordered futures first, then by distance from today's
 * ATM (in listed strikes), then expiry, CE before PE; cut at maxContracts.
 */
export function selectContracts(input: SelectInput): Selection {
  const ranked: Array<{ c: OiContract; dist: number }> = [];
  for (const [, contracts] of [...input.options].sort((a, b) => a[0].localeCompare(b[0]))) {
    const listed = [...new Set(contracts.map((c) => c.strike).filter((s): s is number => s !== null))].sort((a, b) => a - b);
    if (listed.length === 0) continue;
    const lo = listed.indexOf(atmStrike(listed, Math.min(input.low, input.high)) as number);
    const hi = listed.indexOf(atmStrike(listed, Math.max(input.low, input.high)) as number);
    const atm = listed.indexOf(atmStrike(listed, input.last) as number);
    const from = Math.max(0, lo - input.strikesAround);
    const to = Math.min(listed.length - 1, hi + input.strikesAround);
    const rank = new Map(listed.map((s, i) => [s, Math.abs(i - atm)] as const));
    for (const c of contracts) {
      if (c.strike === null) continue;
      const i = listed.indexOf(c.strike);
      if (i < from || i > to) continue;
      ranked.push({ c, dist: rank.get(c.strike) ?? 0 });
    }
  }
  ranked.sort((a, b) => a.dist - b.dist || a.c.expiry.localeCompare(b.c.expiry) || a.c.kind.localeCompare(b.c.kind) || (a.c.strike ?? 0) - (b.c.strike ?? 0));
  const futures = [...input.futures].sort((a, b) => a.expiry.localeCompare(b.expiry));
  const room = Math.max(0, input.maxContracts - futures.length);
  return {
    contracts: [...futures.slice(0, input.maxContracts), ...ranked.slice(0, room).map((r) => r.c)],
    capped: Math.max(0, ranked.length - room),
  };
}
