import type { SessionClock } from '../../market-hub/session-clock';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { LimitScope } from './limits/limit-keys';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Where each core vehicle trades (a venue map, not a risk value). */
export const VEHICLE_EXCHANGES: Readonly<Record<Vehicle, readonly string[]>> = {
  CASH_INTRADAY: ['NSE'],
  MTF: ['NSE'],
  OPTIONS_BUY: ['NFO'],
};

export function exchangesForScope(scope: LimitScope): string[] {
  const vehicles: readonly Vehicle[] = scope === 'ALL' ? VEHICLES : [scope];
  return [...new Set(vehicles.flatMap((v) => VEHICLE_EXCHANGES[v]))];
}

export const ALL_CORE_EXCHANGES: readonly string[] = exchangesForScope('ALL');

/**
 * D5: when a looser change may take effect. The LATEST next open across the given
 * exchanges, so it never lands inside any of their sessions; null when any exchange
 * has no open within the clock's 14-day search (the caller refuses the change).
 */
export function nextSessionOpen(
  clock: Pick<SessionClock, 'nextOpen'>,
  exchanges: readonly string[],
  now: Date,
): Date | null {
  if (exchanges.length === 0) return null;
  let latest: Date | null = null;
  for (const exchange of exchanges) {
    const open = clock.nextOpen(exchange, now);
    if (!open) return null;
    if (!latest || open.getTime() > latest.getTime()) latest = open;
  }
  return latest;
}

/** Minutes since IST midnight. */
export function istMinutesOf(at: Date): number {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
