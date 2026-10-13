import type { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import { isActiveStatus, type CorePosition } from '../lifecycle/lifecycle.types';
import { reducePosition } from '../lifecycle/position-state';
import { hhmmToMinutes } from '../risk-wall/limits/limit-keys';
import { istMinutesOf } from '../risk-wall/session-open';
import type { JournalRow } from './journal.types';

/** Spec §8.3 checks (ruling J17). */
export const RECON_CHECKS = [
  'FILLS_VS_ORDER',
  'POSITION_VS_ORDERS',
  'STUCK_ORDER',
  'STUCK_EXITING',
  'SUMMARY_MISSING',
  'INTRADAY_OPEN_AFTER_SQUARE_OFF',
  'MTF_INTEREST_MISSING',
  'MARGIN_LEFT_ON_CLOSED',
] as const;
export type ReconCheck = (typeof RECON_CHECKS)[number];

export interface ReconFinding {
  check: ReconCheck;
  /** Stable across runs: the same problem has the same fingerprint (J11 dedupe with the IST day). */
  fingerprint: string;
  /** The strategy whose entries a finding blocks; null = every strategy of the user (O10). */
  strategyId: string | null;
  positionId: string | null;
  orderId: string | null;
  detail: string;
  /** CANCEL_ENTRY: cancel a stuck entry order; WRITE_SUMMARY: write the missing summary. Exits are never repaired by cancelling. */
  repair: 'CANCEL_ENTRY' | 'WRITE_SUMMARY' | null;
}

/** One user's core state for today, as the reconciler reads it. */
export interface ReconSnapshot {
  now: Date;
  /** Active positions and those closed or cancelled today. */
  positions: readonly CorePosition[];
  ordersByPosition: ReadonlyMap<string, readonly CoreOrder[]>;
  /** Σ core_fills.qty per order. */
  fillQtyByOrder: ReadonlyMap<string, number>;
  /** Margin each order still holds. */
  marginByOrder: ReadonlyMap<string, Prisma.Decimal>;
  /** CLOSED positions that have a summary. */
  summarised: ReadonlySet<string>;
  /** Tokens with an MTF_INTEREST row for today. */
  interestTokensToday: ReadonlySet<string>;
  /** J18: 2 × noPriceRejectMs. */
  stuckAfterMs: number;
}

export interface ReconBlock {
  all: boolean;
  strategyIds: readonly string[];
}

const OPEN_ORDER_STATES: ReadonlySet<string> = new Set(['NEW', 'OPEN']);
const INTRADAY_VEHICLES: ReadonlySet<string> = new Set(['CASH_INTRADAY', 'OPTIONS_BUY']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const minutes = (ms: number): number => Math.floor(ms / 60_000);

function finding(check: ReconCheck, f: Omit<ReconFinding, 'check' | 'fingerprint'>): ReconFinding {
  return { check, fingerprint: `${check}:${f.positionId ?? '-'}:${f.orderId ?? '-'}`, ...f };
}

export function intradayFindings(s: ReconSnapshot): ReconFinding[] {
  const out: ReconFinding[] = [];
  const now = s.now.getTime();
  for (const p of s.positions) {
    const orders = s.ordersByPosition.get(p.id) ?? [];
    const base = { strategyId: p.strategyId, positionId: p.id };
    for (const o of orders) {
      const filled = s.fillQtyByOrder.get(o.id) ?? 0;
      if (filled !== o.filledQty) {
        out.push(finding('FILLS_VS_ORDER', { ...base, orderId: o.id, repair: null, detail: `order ${o.id} says ${o.filledQty} filled; its fills sum to ${filled}` }));
      }
      if (OPEN_ORDER_STATES.has(o.state) && now - o.submittedAt.getTime() > s.stuckAfterMs) {
        out.push(finding('STUCK_ORDER', {
          ...base, orderId: o.id, repair: o.purpose === 'ENTRY' ? 'CANCEL_ENTRY' : null,
          detail: `${o.purpose} order ${o.id} has been ${o.state} for ${minutes(now - o.submittedAt.getTime())} min`,
        }));
      }
    }
    const newest = orders.reduce((m, o) => Math.max(m, o.updatedAt.getTime()), 0);
    if (orders.length > 0 && now - newest > s.stuckAfterMs) {
      try {
        const f = reducePosition(p.status, orders);
        if (f.entryFilledQty !== p.entryFilledQty || f.exitFilledQty !== p.exitFilledQty) {
          out.push(finding('POSITION_VS_ORDERS', {
            ...base, orderId: null, repair: null,
            detail: `position says entry ${p.entryFilledQty} / exit ${p.exitFilledQty}; its orders say ${f.entryFilledQty} / ${f.exitFilledQty}`,
          }));
        }
      } catch (err) {
        out.push(finding('POSITION_VS_ORDERS', { ...base, orderId: null, repair: null, detail: errorText(err) }));
      }
    }
    if (p.status === 'EXITING') {
      const lastExit = orders.filter((o) => o.purpose === 'EXIT').reduce((m, o) => Math.max(m, o.submittedAt.getTime()), 0);
      const since = lastExit > 0 ? lastExit : p.updatedAt.getTime();
      if (now - since > s.stuckAfterMs) {
        out.push(finding('STUCK_EXITING', { ...base, orderId: null, repair: null, detail: `EXITING with no new exit order for ${minutes(now - since)} min` }));
      }
    }
    if (p.status === 'CLOSED' && !s.summarised.has(p.id)) {
      out.push(finding('SUMMARY_MISSING', { ...base, orderId: null, repair: 'WRITE_SUMMARY', detail: `closed position ${p.id} has no trade summary` }));
    }
  }
  return out;
}

export function nightlyFindings(s: ReconSnapshot): ReconFinding[] {
  const out = intradayFindings(s);
  const nowMin = istMinutesOf(s.now);
  for (const p of s.positions) {
    const base = { strategyId: p.strategyId, positionId: p.id };
    if (isActiveStatus(p.status) && INTRADAY_VEHICLES.has(p.vehicle) && nowMin >= hhmmToMinutes(p.plan.squareOffHhmm)) {
      out.push(finding('INTRADAY_OPEN_AFTER_SQUARE_OFF', { ...base, orderId: null, repair: null, detail: `${p.vehicle} position is ${p.status} after its ${p.plan.squareOffHhmm} square-off` }));
    }
    if (p.vehicle === 'MTF' && isActiveStatus(p.status) && p.openQty > 0 && !s.interestTokensToday.has(p.instrument.token)) {
      out.push(finding('MTF_INTEREST_MISSING', { ...base, orderId: null, repair: null, detail: `no MTF interest row today for ${p.instrument.symbol}` }));
    }
    if (p.status === 'CLOSED' || p.status === 'CANCELLED') {
      // Per POSITION, not per order: M3 books an exit fill's MARGIN_RELEASE on the exit order, so a
      // cleanly closed position holds +X on its entry order and −X on its exit order(s).
      const orders = s.ordersByPosition.get(p.id) ?? [];
      let held: Prisma.Decimal | null = null;
      for (const o of orders) {
        const m = s.marginByOrder.get(o.id);
        if (m) held = held ? held.plus(m) : m;
      }
      if (held && !held.isZero()) {
        out.push(finding('MARGIN_LEFT_ON_CLOSED', { ...base, orderId: null, repair: null, detail: `the orders of ${p.status} position ${p.id} still hold ₹${held.toFixed(2)} margin in sum` }));
      }
    }
  }
  return out;
}

/** O10: unacknowledged findings → the entry block the Risk Wall applies (RECON_BLOCKED). */
export function reconBlockOf(rows: readonly JournalRow[]): ReconBlock {
  const ids: string[] = [];
  let all = false;
  for (const r of rows) {
    if (r.strategyId === null) all = true;
    else if (!ids.includes(r.strategyId)) ids.push(r.strategyId);
  }
  return { all, strategyIds: ids };
}
