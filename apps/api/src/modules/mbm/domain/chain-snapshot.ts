// apps/api/src/modules/mbm/domain/chain-snapshot.ts
// Pure pieces of the MBM NIFTY option-chain capture (MBM_CHAIN_CAPTURE): the capture window, ATM and
// the ±N strike selection, and one snapshot row with PCR / max pain / call + put walls. No I/O.
import type { OptionGreekRow, OptionSide } from '../../market-hub/chain/chain.types';
import type { NseCalendar } from './bar-window';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Strikes kept each side of ATM. */
export const CHAIN_STRIKES_AROUND = 15;
/** Nearest expiries captured per tick. */
export const CHAIN_EXPIRIES = 2;
/** Capture ticks run 09:15–15:30 IST inclusive (the NSE cash/F&O session). */
export const CAPTURE_FROM_MIN = 9 * 60 + 15;
export const CAPTURE_TO_MIN = 15 * 60 + 30;

/** True when a capture tick at `now` should run: an NSE trading day (holidays excluded), 09:15–15:30 IST. */
export function isChainCaptureTick(cal: NseCalendar, now: Date): boolean {
  if (!cal.isTradingDay('NSE', now)) return false;
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= CAPTURE_FROM_MIN && m <= CAPTURE_TO_MIN;
}

/** IST calendar day (YYYY-MM-DD) of an instant. */
export function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The listed strike nearest `spot` (the lower one on an exact tie); null when nothing is listed. */
export function atmStrike(strikes: readonly number[], spot: number): number | null {
  let best: number | null = null;
  for (const s of strikes) {
    if (best === null || Math.abs(s - spot) < Math.abs(best - spot) || (Math.abs(s - spot) === Math.abs(best - spot) && s < best)) {
      best = s;
    }
  }
  return best;
}

/** ATM plus `n` listed strikes each side (fewer at the edge of the listing), ascending. */
export function strikesAround(strikes: readonly number[], spot: number, n = CHAIN_STRIKES_AROUND): number[] {
  const listed = [...new Set(strikes)].sort((a, b) => a - b);
  const atm = atmStrike(listed, spot);
  if (atm === null) return [];
  const i = listed.indexOf(atm);
  return listed.slice(Math.max(0, i - n), i + n + 1);
}

/** One side of one strike. Every field is null when the source did not give it. */
export interface ChainLeg {
  ltp: number | null;
  oi: number | null;
  /** OI minus the same contract's last captured OI of the PREVIOUS session (null with no baseline). */
  oi_chg: number | null;
  vol: number | null;
  /** Broker IV (Angel optionGreek, percent) and Greeks; null when the greek call gave none. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface ChainStrikeRow {
  strike: number;
  /** null: no contract listed for this side, or the broker did not quote it. */
  ce: ChainLeg | null;
  pe: ChainLeg | null;
}

export interface ChainSnapshotRow {
  instrument: string;
  /** YYYY-MM-DD */
  expiry: string;
  capturedAt: Date;
  spot: number;
  pcr: number | null;
  maxPain: number | null;
  callWall: number | null;
  putWall: number | null;
  strikes: ChainStrikeRow[];
}

/** One option contract of the expiry (from the instrument master). */
export interface CaptureContract {
  token: string;
  strike: number;
  optionType: OptionSide;
}

/** The slice of a FULL quote the capture stores. */
export interface CaptureQuote {
  ltp: number;
  oi?: number;
  volume: number;
}

export interface BuildSnapshotInput {
  instrument: string;
  expiry: string;
  capturedAt: Date;
  spot: number;
  /** The expiry's contracts already narrowed to the captured strikes (see strikesAround). */
  contracts: readonly CaptureContract[];
  /** token → quote; a missing token is an unquoted leg. */
  quotes: ReadonlyMap<string, CaptureQuote>;
  greeks: readonly OptionGreekRow[] | null;
  /** `${strike}:${CE|PE}` → previous-session OI. */
  baseline: ReadonlyMap<string, number> | null;
}

const legKey = (strike: number, side: OptionSide) => `${strike}:${side}`;
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Σ PE OI / Σ CE OI over the rows; null when there is no CE OI. */
export function pcrByOi(rows: readonly ChainStrikeRow[]): number | null {
  let ce = 0;
  let pe = 0;
  for (const r of rows) {
    ce += r.ce?.oi ?? 0;
    pe += r.pe?.oi ?? 0;
  }
  return ce > 0 ? pe / ce : null;
}

/**
 * Max pain over the captured strikes: the expiry price K (a captured strike) that minimises the total
 * intrinsic value paid to option holders, Σ CE_OI·max(0, K − s) + PE_OI·max(0, s − K). Ties → lower K.
 * null when no leg has OI. Bounded to the ±N window, so it is the window's max pain, not the full chain's.
 */
export function maxPain(rows: readonly ChainStrikeRow[]): number | null {
  if (!rows.some((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0)) return null;
  let best: number | null = null;
  let bestPain = Infinity;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += (r.ce?.oi ?? 0) * Math.max(0, k.strike - r.strike) + (r.pe?.oi ?? 0) * Math.max(0, r.strike - k.strike);
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = k.strike;
    }
  }
  return best;
}

/** Strike with the largest OI on one side (ties → lower strike); null when that side has no OI. */
export function wall(rows: readonly ChainStrikeRow[], side: 'ce' | 'pe'): number | null {
  let best: number | null = null;
  let bestOi = 0;
  for (const r of rows) {
    const oi = r[side]?.oi ?? 0;
    if (oi > bestOi) {
      bestOi = oi;
      best = r.strike;
    }
  }
  return best;
}

/** One mbm_chain_snapshots row from the quoted contracts. Rows ascend by strike. */
export function buildChainSnapshot(i: BuildSnapshotInput): ChainSnapshotRow {
  const greekBy = new Map<string, OptionGreekRow>();
  for (const g of i.greeks ?? []) greekBy.set(legKey(g.strike, g.optionType), g);

  const leg = (c: CaptureContract | undefined): ChainLeg | null => {
    if (!c) return null;
    const q = i.quotes.get(c.token);
    if (!q) return null;
    const oi = finite(q.oi);
    const base = i.baseline?.get(legKey(c.strike, c.optionType));
    const g = greekBy.get(legKey(c.strike, c.optionType));
    return {
      ltp: finite(q.ltp),
      oi,
      oi_chg: oi !== null && base !== undefined ? oi - base : null,
      vol: finite(q.volume),
      iv: finite(g?.iv),
      delta: finite(g?.delta),
      gamma: finite(g?.gamma),
      theta: finite(g?.theta),
      vega: finite(g?.vega),
    };
  };

  const byStrike = new Map<number, { ce?: CaptureContract; pe?: CaptureContract }>();
  for (const c of i.contracts) {
    const e = byStrike.get(c.strike) ?? {};
    if (c.optionType === 'CE') e.ce = c;
    else e.pe = c;
    byStrike.set(c.strike, e);
  }
  const strikes: ChainStrikeRow[] = [...byStrike.entries()]
    .sort(([a], [b]) => a - b)
    .map(([strike, e]) => ({ strike, ce: leg(e.ce), pe: leg(e.pe) }));

  return {
    instrument: i.instrument,
    expiry: i.expiry,
    capturedAt: i.capturedAt,
    spot: i.spot,
    pcr: pcrByOi(strikes),
    maxPain: maxPain(strikes),
    callWall: wall(strikes, 'ce'),
    putWall: wall(strikes, 'pe'),
    strikes,
  };
}

/** `${strike}:${side}` → OI from a stored snapshot's strikes (the next session's oi_chg baseline). */
export function baselineFrom(rows: readonly ChainStrikeRow[] | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows ?? []) {
    if (r.ce?.oi != null) out.set(legKey(r.strike, 'CE'), r.ce.oi);
    if (r.pe?.oi != null) out.set(legKey(r.strike, 'PE'), r.pe.oi);
  }
  return out;
}
