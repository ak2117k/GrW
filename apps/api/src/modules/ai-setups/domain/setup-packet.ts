import type { OptionData, OptionsChainEntry } from '@td/shared/types';
import { parseMasterExpiry } from '../../market-data/services/master-contract';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import { atr14 } from '../../signal-trader/domain/atr';
import { MCX_LAST_VALID, NSE_LAST_VALID } from './setup-checks';

/**
 * Pure pieces of the setup packet (spec §5.2): daily-60 stats, the 15m view (today + previous session, ATR15m,
 * VWAP), the option chain rows around ATM, and the time left in the session. Never anything finer than 15m.
 *
 * Field names matter: `packetLevels` (setup-checks) treats dayHigh / dayLow / prevHigh / prevLow / prevClose /
 * high60d / low60d / vwap anywhere in a present block, and swing highs / lows of bars under a `bars15m` key, as
 * UNDERLYING levels an entry may anchor to. Option-chain rows therefore never use those names.
 */

const IST_OFFSET_MS = 330 * 60_000;
const BAR_15M_MS = 15 * 60_000;
const ATR_PERIOD = 14;
const AVG_VOLUME_SESSIONS = 20;
const RANGE_SESSIONS = 60;
/** Prior daily sessions listed bar by bar (the rest are summarised). */
const RECENT_DAILY = 10;
/** Strikes each side of ATM in the chain block. */
export const CHAIN_STRIKES_EACH_SIDE = 5;

/** Session window, IST minutes: NSE / BSE 09:15–15:30, MCX 09:00–23:30. */
const SESSION_MIN: Record<string, [number, number]> = { NSE: [555, 930], BSE: [555, 930], NFO: [555, 930], BFO: [555, 930], MCX: [540, 1410] };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pos = (v: unknown): v is number => finite(v) && v > 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

const istMinutes = (ms: number) => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
/** IST 'YYYY-MM-DD HH:mm'. */
export const istStamp = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
const sessionOf = (exchange: string) => SESSION_MIN[exchange.toUpperCase()] ?? SESSION_MIN.NSE;

export interface DailyStats {
  /** Sessions before today the stats were computed from. */
  sessions: number;
  /** Simple ATR(14) of the prior daily bars; null with fewer than 15. */
  atr14: number | null;
  /** Mean daily volume of the 20 sessions before today; null with fewer than 20 or missing volume. */
  avgVolume20d: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  prevClose: number | null;
  /** Highest high / lowest low of the 60 sessions before today; null with fewer than 60. */
  high60d: number | null;
  low60d: number | null;
  /** Highest high / lowest low of the 20 sessions before today; null with fewer than 20. */
  high20d: number | null;
  low20d: number | null;
  /** The last 10 prior sessions, oldest first. */
  recent: Array<{ day: string; high: number; low: number; close: number; volume: number | null }>;
}

/** Daily stats from bars dated before `today` (today's forming daily bar is ignored). */
export function dailyStats(daily: readonly DailyBar[], today: string): DailyStats {
  const prior = daily.filter((b) => b.day < today).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-RANGE_SESSIONS);
  const prev = prior.length ? prior[prior.length - 1] : null;
  const last20 = prior.slice(-AVG_VOLUME_SESSIONS);
  const vols = last20.map((b) => b.volume);
  const full20 = last20.length === AVG_VOLUME_SESSIONS;
  const full60 = prior.length === RANGE_SESSIONS;
  return {
    sessions: prior.length,
    atr14: prior.length > ATR_PERIOD ? atr14(prior, ATR_PERIOD) : null,
    avgVolume20d: full20 && vols.every(pos) ? Math.round((vols as number[]).reduce((a, b) => a + b, 0) / vols.length) : null,
    prevHigh: prev?.high ?? null,
    prevLow: prev?.low ?? null,
    prevClose: prev?.close ?? null,
    high60d: full60 ? Math.max(...prior.map((b) => b.high)) : null,
    low60d: full60 ? Math.min(...prior.map((b) => b.low)) : null,
    high20d: full20 ? Math.max(...last20.map((b) => b.high)) : null,
    low20d: full20 ? Math.min(...last20.map((b) => b.low)) : null,
    recent: prior.slice(-RECENT_DAILY).map((b) => ({ day: b.day, high: b.high, low: b.low, close: b.close, volume: pos(b.volume) ? b.volume : null })),
  };
}

export interface RawBar15m {
  /** Bar start, ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Bars15mView {
  /** IST session days covered, oldest first (today and the previous session). */
  sessions: string[];
  /** Simple ATR(14) of these closed 15m bars; null with fewer than 15. */
  atr15m: number | null;
  /** Today's volume-weighted average price from today's closed 15m bars; null when there is no volume (an index) or no bar yet. */
  vwap: number | null;
  /** Closed bars, oldest first; `ts` = bar start, IST 'YYYY-MM-DD HH:mm'. */
  bars: Array<{ ts: string; open: number; high: number; low: number; close: number; volume: number | null }>;
}

/**
 * The 15m view: CLOSED bars (start + 15 min ≤ now) inside the venue's session, from today and the previous
 * session only (the last two IST days ≤ today that have bars), oldest first, with ATR15m and today's VWAP.
 */
export function bars15mView(raw: readonly RawBar15m[], exchange: string, now: Date, today: string): Bars15mView {
  const [open, close] = sessionOf(exchange);
  const ok = raw
    .filter((b) => finite(b.ts) && [b.open, b.high, b.low, b.close].every(pos))
    .filter((b) => b.ts + BAR_15M_MS <= now.getTime())
    .filter((b) => {
      const m = istMinutes(b.ts);
      return m >= open && m < close && istYmd(new Date(b.ts)) <= today;
    })
    .sort((a, b) => a.ts - b.ts);
  const days = [...new Set(ok.map((b) => istYmd(new Date(b.ts))))].slice(-2);
  const kept = ok.filter((b) => days.includes(istYmd(new Date(b.ts))));
  const todays = kept.filter((b) => istYmd(new Date(b.ts)) === today && pos(b.volume));
  const vol = todays.reduce((a, b) => a + (b.volume as number), 0);
  const vwap = vol > 0 ? r2(todays.reduce((a, b) => a + ((b.high + b.low + b.close) / 3) * (b.volume as number), 0) / vol) : null;
  return {
    sessions: days,
    atr15m: kept.length > ATR_PERIOD ? atr14(kept, ATR_PERIOD) : null,
    vwap,
    bars: kept.map((b) => ({ ts: istStamp(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: pos(b.volume) ? b.volume : null })),
  };
}

/** The nearest listed expiry AFTER today (never an expiry-day contract); null when none. Accepts YYYY-MM-DD only. */
export function nearestNonExpiryDay(expiries: readonly string[], today: string): string | null {
  return [...expiries].filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e > today).sort()[0] ?? null;
}

/** One side of a chain row. Never named like an underlying level (no dayHigh / vwap / …). */
export interface SetupChainLeg {
  ltp: number | null;
  oi: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  /** (ask − bid) / mid × 100; null without both a bid and an ask. */
  spreadPct: number | null;
  /** null when the chain had no Greek for this leg. */
  delta: number | null;
  iv: number | null;
}

export interface SetupChainRow {
  strike: number;
  ce: SetupChainLeg | null;
  pe: SetupChainLeg | null;
}

function leg(d: OptionData | null): SetupChainLeg | null {
  if (!d) return null;
  const bid = pos(d.bidPrice) ? d.bidPrice : null;
  const ask = pos(d.askPrice) ? d.askPrice : null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  return {
    ltp: pos(d.ltp) ? d.ltp : null,
    oi: finite(d.oi) && d.oi >= 0 ? d.oi : null,
    volume: finite(d.volume) && d.volume >= 0 ? d.volume : null,
    bid,
    ask,
    spreadPct: mid !== null && ask! >= bid! ? r2(((ask! - bid!) / mid) * 100) : null,
    // A hub chain with no Greeks carries 0 for every leg: that is "unknown", not a zero delta.
    delta: finite(d.delta) && d.delta !== 0 ? d.delta : null,
    iv: pos(d.iv) ? d.iv : null,
  };
}

/** ATM ± `n` listed strikes around `spot`, ascending. */
export function chainRows(entries: readonly OptionsChainEntry[], spot: number, n = CHAIN_STRIKES_EACH_SIDE): SetupChainRow[] {
  const listed = [...entries].filter((e) => pos(e.strikePrice)).sort((a, b) => a.strikePrice - b.strikePrice);
  if (listed.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < listed.length; i++) {
    if (Math.abs(listed[i].strikePrice - spot) < Math.abs(listed[atm].strikePrice - spot)) atm = i;
  }
  return listed.slice(Math.max(0, atm - n), atm + n + 1).map((e) => ({ strike: e.strikePrice, ce: leg(e.ceData), pe: leg(e.peData) }));
}

/** The chain's own lot size (hub chains carry it per leg); null when no leg has one. */
export function chainLotSize(entries: readonly OptionsChainEntry[]): number | null {
  for (const e of entries) {
    for (const d of [e.ceData, e.peData]) if (d && pos(d.lotSize)) return d.lotSize;
  }
  return null;
}

type Row = Record<string, unknown>;
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** An option's lot size from the instrument master: the expiry's own row first, else any option row of the underlying on `seg`. */
export function masterLotSize(master: readonly unknown[], underlying: string, seg: string, expiry: string | null): number | null {
  let any: number | null = null;
  for (const r of master as Row[]) {
    if (!r || up(r.exch_seg) !== seg || up(r.name) !== underlying || !/^OPT/.test(up(r.instrumenttype))) continue;
    const lot = Number(r.lotsize);
    if (!pos(lot)) continue;
    const e = parseMasterExpiry(r.expiry);
    if (expiry && e && ymdLocal(e) === expiry) return lot;
    any ??= lot;
  }
  return any;
}

export interface TimeToClose {
  /** Now, IST 'HH:mm'. */
  nowIst: string;
  /** Latest validUntil a setup may carry (intraday only): 15:15 NSE / BSE, 23:00 MCX. */
  lastValidIst: string;
  /** Minutes from now to lastValidIst (≤ 0 = too late for a new setup). */
  minutesLeft: number;
}

export function timeToClose(exchange: string, now: Date): TimeToClose {
  const last = up(exchange) === 'MCX' ? MCX_LAST_VALID : NSE_LAST_VALID;
  const [h, m] = last.split(':').map(Number);
  const nowMin = istMinutes(now.getTime());
  return { nowIst: istStamp(now.getTime()).slice(11), lastValidIst: last, minutesLeft: h * 60 + m - nowMin };
}
