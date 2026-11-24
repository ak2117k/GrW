import { Prisma } from '@prisma/client';
import { venueSession } from '../../exit-discipline/session-bars';

/**
 * SQL form of exit-discipline/session-bars (the one source of truth for venue sessions) for every reader of
 * candles_1m (2026-11-24). candles_1m keeps every tick-built minute of NSE/BSE lines — flat copies from ~02:00,
 * the 09:00–09:08 pre-open auction (BANKNIFTY 23-Nov 09:00 bar spanned 1,100 pts that never traded), flat bars to
 * 09:14 and after 15:30 — and flat MCX copies before 09:00. Readers keep only minutes STARTING inside the session:
 *   NSE / NFO / BSE / BFO  [09:15, 15:30) IST     MCX*  [09:00, 23:55) IST     anything else: no filter.
 */
const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** `AND <column>'s IST time is inside the venue's session`, or an empty fragment for a venue with no known session. */
export function sessionMinuteFilter(exchange: string | null | undefined, column = 'ts'): Prisma.Sql {
  const s = venueSession(exchange);
  if (!s) return Prisma.empty;
  if (!/^[a-z_][a-z0-9_."]*$/i.test(column)) throw new Error(`sessionMinuteFilter: bad column ${column}`);
  const col = Prisma.raw(column);
  return Prisma.sql` AND (${col} AT TIME ZONE 'Asia/Kolkata')::time >= ${hhmm(s.fromMin)}::time AND (${col} AT TIME ZONE 'Asia/Kolkata')::time < ${hhmm(s.toMin)}::time`;
}
