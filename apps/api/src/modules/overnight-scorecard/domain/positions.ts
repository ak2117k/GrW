/**
 * Which trackers the scorecard scores, and which way each one needs the underlying to move.
 *
 * "Real Angel overnight positions" (design §1): `trade_trackers` rows are created ONLY by the broker
 * reconcile (`TradeTrackerService.reconcile`, fed by Angel's position/holding book via the 10-minute
 * cron and live-broker-sync), so every OPEN tracker is a real broker position. Paper/app trades live
 * in their own tables and never appear here. Of those we take kind POSITION (never a long-term
 * HOLDING, the sentinel's own scope rule) on an equity venue (NSE/BSE/NFO/BFO): MCX is still trading
 * at 15:40, so its positions are not "overnight" at that window.
 */
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { baseSymbol } from '../../news-events/keys';
import { underlyingName } from '../../night-report/domain/night-report.logic';
import type { Side } from './scoring';

export const EQUITY_VENUES: ReadonlySet<string> = new Set(['NSE', 'BSE', 'NFO', 'BFO']);

export interface TrackerLite {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  kind: string;
  qty: number;
  status: string;
}

export function isOvernightCandidate(t: TrackerLite): boolean {
  return t.status === 'OPEN' && t.kind === 'POSITION' && EQUITY_VENUES.has(t.exchange.toUpperCase()) && t.qty !== 0;
}

export interface PositionShape {
  underlying: string;
  isIndex: boolean;
  isOption: boolean;
  isLongOption: boolean;
  optionType: 'CE' | 'PE' | null;
  /** 'YYYY-MM-DD' parsed from the tradingsymbol's DDMMMYY; null for cash / unknown. */
  expiry: string | null;
  side: Side;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CONTRACT = /^([A-Z&-]+?)(\d{2})([A-Z]{3})(\d{2})(?:\d+(?:\.\d+)?(CE|PE)|FUT)$/;

export function shapeOf(symbol: string, exchange: string, qty: number): PositionShape {
  const sym = String(symbol).trim().toUpperCase();
  const name = underlyingName(sym, exchange) ?? baseSymbol(sym);
  const m = CONTRACT.exec(sym);
  const optionType = (m?.[5] as 'CE' | 'PE' | undefined) ?? null;
  const mi = m ? MONTHS.indexOf(m[3]) : -1;
  const expiry = m && mi >= 0 ? `20${m[4]}-${String(mi + 1).padStart(2, '0')}-${m[2]}` : null;
  const long = qty > 0;
  // Long CE / short PE / long future or cash need the underlying UP.
  const bullish = optionType === 'PE' ? !long : long;
  return {
    underlying: name,
    isIndex: !!INDEX_UNDERLYINGS[name],
    isOption: optionType !== null,
    isLongOption: optionType !== null && long,
    optionType,
    expiry,
    side: bullish ? 'BULLISH' : 'BEARISH',
  };
}
