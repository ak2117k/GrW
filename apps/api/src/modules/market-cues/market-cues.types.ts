/**
 * Market cues — the shapes every consumer reads. Pure types, no imports, so the
 * sentinel's import-graph walk can follow them without reaching anything.
 *
 * EVERY STORED VALUE carries its own provenance: the source's own time (or the
 * session date it describes), when we fetched it, what that time means
 * (`basis`), where it came from, and a status. A missing reading is `values:
 * null` with a `reason` — never a zero.
 */

export type CueStatus = 'ok' | 'stale' | 'unavailable';

export interface CueRecord<T> {
  values: T | null;
  /** The source's own time (ISO) or the session date it describes ('YYYY-MM-DD'). Never our fetch time. */
  sourceTime: string | null;
  /** When we fetched it (ISO), or null when never fetched. */
  fetchedAt: string | null;
  /** What `sourceTime` means — e.g. 'previous US session close', 'quote time'. */
  basis: string;
  /** The endpoint the values came from — the fallback's name when the fallback served. */
  source: string;
  status: CueStatus;
  /** Why the status is not 'ok' (or a note that still applies when it is). */
  reason?: string;
}

export interface UsQuote {
  symbol: string;
  last: number;
  previousClose: number;
  change: number;
  changePercent: number;
}

export type UsCueKey = 'nasdaq' | 'sp500' | 'dow' | 'nasdaqFutures' | 'sp500Futures';
export const US_CUE_KEYS: readonly UsCueKey[] = ['nasdaq', 'sp500', 'dow', 'nasdaqFutures', 'sp500Futures'];

export interface BuySellNet {
  buy: number;
  sell: number;
  net: number;
}

export interface FiiDiiCash {
  /** The trading session the figures describe, 'YYYY-MM-DD'. */
  date: string;
  fii: BuySellNet;
  /** Null from the NSDL fallback, which has no DII. */
  dii: BuySellNet | null;
  unit: '₹ crore';
}

export interface LongShort {
  long: number;
  short: number;
}

export interface FiiIndexPositions {
  date: string;
  indexFutures: LongShort;
  indexCalls: LongShort;
  indexPuts: LongShort;
}

export interface FiiDerivatives extends FiiIndexPositions {
  unit: 'contracts';
  /** Change vs the previous session's file, or null when that file could not be had. */
  change: (Omit<FiiIndexPositions, 'date'> & { previousDate: string }) | null;
}

export interface GiftReading {
  price: number;
  /** 'YYYY-MM-DD'. */
  expiry: string;
  /** ISO, from the venue's own timestamp (IST). */
  at: string;
  dayChange: number | null;
}

export interface NiftyFutureClose {
  close: number;
  expiry: string;
  sessionDate: string;
  closedAt: string | null;
}

export interface GiftGap {
  gift: GiftReading;
  niftyFuture: NiftyFutureClose | null;
  /** GIFT price minus the NSE NIFTY current-month future close; null without that close. */
  gap: number | null;
  gapPercent: number | null;
  expiryMatches: boolean | null;
  comparison: string;
}

export interface PreOpenEntry {
  symbol: string;
  /** What the IEP prices: the cash equity, or a future. */
  instrument: 'CASH' | 'FUTURE';
  iep: number;
  previousClose: number;
  change: number | null;
  changePercent: number | null;
  at: string;
}

export interface PreOpenBook {
  date: string;
  entries: Record<string, PreOpenEntry>;
}

export interface MarketCuesSnapshot {
  enabled: boolean;
  us: Record<UsCueKey, CueRecord<UsQuote>>;
  fiiDii: CueRecord<FiiDiiCash>;
  fiiOi: CueRecord<FiiDerivatives>;
  gift: CueRecord<GiftGap>;
  preOpen: CueRecord<PreOpenBook>;
}

export type CueGroup = 'us' | 'fiiDii' | 'fiiOi' | 'gift' | 'preOpen';
