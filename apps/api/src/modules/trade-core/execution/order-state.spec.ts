import { ORDER_STATES } from './execution.types';
import { IllegalOrderTransition, isOpenState, nextState, OPEN_STATES, ORDER_EVENTS, transition } from './order-state';

describe('order state machine (spec §4.1: NEW → OPEN → PARTIAL → FILLED | CANCELLED | REJECTED)', () => {
  it('allows exactly these transitions', () => {
    const allowed: string[] = [];
    for (const s of ORDER_STATES) {
      for (const e of ORDER_EVENTS) {
        const n = nextState(s, e);
        if (n) allowed.push(`${s} -${e}-> ${n}`);
      }
    }
    expect(allowed.sort()).toEqual(
      [
        'NEW -ACCEPT-> OPEN',
        'NEW -REJECT-> REJECTED',
        'OPEN -CANCEL-> CANCELLED',
        'OPEN -FILL-> FILLED',
        'OPEN -PARTIAL_FILL-> PARTIAL',
        'OPEN -REJECT-> REJECTED',
        'PARTIAL -CANCEL-> CANCELLED',
        'PARTIAL -FILL-> FILLED',
        'PARTIAL -PARTIAL_FILL-> PARTIAL',
      ].sort(),
    );
  });

  it('terminal states accept no event', () => {
    for (const s of ['FILLED', 'CANCELLED', 'REJECTED'] as const) {
      expect(ORDER_EVENTS.map((e) => nextState(s, e))).toEqual(ORDER_EVENTS.map(() => null));
    }
  });

  it('transition returns the next state and throws on an illegal move', () => {
    expect(transition('NEW', 'ACCEPT')).toBe('OPEN');
    expect(() => transition('FILLED', 'CANCEL')).toThrow(IllegalOrderTransition);
    expect(() => transition('PARTIAL', 'REJECT')).toThrow('PARTIAL');
  });

  it('the open states are NEW, OPEN and PARTIAL', () => {
    expect(OPEN_STATES).toEqual(['NEW', 'OPEN', 'PARTIAL']);
    expect(ORDER_STATES.filter(isOpenState)).toEqual(['NEW', 'OPEN', 'PARTIAL']);
  });
});
