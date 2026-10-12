import type { OrderState } from './execution.types';

/**
 * The only place an order's state changes (spec §4.5: "State changes only through
 * order-state.ts"). A PARTIAL order has been priced, so it is never rejected for want
 * of a price; it can only fill further or be cancelled.
 */
export const ORDER_EVENTS = ['ACCEPT', 'REJECT', 'PARTIAL_FILL', 'FILL', 'CANCEL'] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

const TRANSITIONS: Readonly<Record<OrderState, Partial<Record<OrderEvent, OrderState>>>> = {
  NEW: { ACCEPT: 'OPEN', REJECT: 'REJECTED' },
  OPEN: { PARTIAL_FILL: 'PARTIAL', FILL: 'FILLED', CANCEL: 'CANCELLED', REJECT: 'REJECTED' },
  PARTIAL: { PARTIAL_FILL: 'PARTIAL', FILL: 'FILLED', CANCEL: 'CANCELLED' },
  FILLED: {},
  CANCELLED: {},
  REJECTED: {},
};

export const OPEN_STATES: readonly OrderState[] = ['NEW', 'OPEN', 'PARTIAL'];

export function isOpenState(s: OrderState): boolean {
  return OPEN_STATES.includes(s);
}

export function nextState(from: OrderState, event: OrderEvent): OrderState | null {
  return TRANSITIONS[from]?.[event] ?? null;
}

export class IllegalOrderTransition extends Error {
  constructor(from: OrderState, event: OrderEvent) {
    super(`an order in ${from} cannot take ${event}`);
    this.name = 'IllegalOrderTransition';
  }
}

export function transition(from: OrderState, event: OrderEvent): OrderState {
  const next = nextState(from, event);
  if (!next) throw new IllegalOrderTransition(from, event);
  return next;
}
