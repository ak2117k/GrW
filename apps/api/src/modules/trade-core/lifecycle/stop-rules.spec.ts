import { advanceMarks, canConvertTargetToTrail, tightenStop, trailDistance, type MarkInput } from './stop-rules';
import { adaptivePlan, cashPlan } from './testing/lifecycle-fixtures';

describe('tightenStop (spec §7.4: the one place a stop changes)', () => {
  it('a long accepts only a higher stop; a short only a lower one', () => {
    expect(tightenStop(494, 495, 'BUY')).toEqual({ accepted: true, stop: 495 });
    expect(tightenStop(494, 493, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(494, 494, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(507.5, 506, 'SELL')).toEqual({ accepted: true, stop: 506 });
    expect(tightenStop(507.5, 508, 'SELL')).toEqual({ accepted: false, stop: 507.5 });
  });

  it('the first stop is accepted; a non-price never is', () => {
    expect(tightenStop(null, 494, 'BUY')).toEqual({ accepted: true, stop: 494 });
    expect(tightenStop(494, Number.NaN, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(494, 0, 'BUY')).toEqual({ accepted: false, stop: 494 });
  });
});

describe('trailDistance', () => {
  const trail = { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' } as const;
  it('multiple × ATR clamped to [minPct, maxPct] of the extreme (silo resolveTrail)', () => {
    expect(trailDistance(trail, 500, 5)).toBe(5);
    expect(trailDistance(trail, 500, 1)).toBeCloseTo(3, 10);
    expect(trailDistance(trail, 500, 10)).toBeCloseTo(7.5, 10);
    expect(trailDistance(trail, 500, null)).toBeCloseTo(3, 10);
  });
});

function marks(over: Partial<MarkInput> = {}): MarkInput {
  return { side: 'BUY', plan: adaptivePlan(), entryAvgPrice: 500, stopPrice: 494, trailActive: false, partialDone: false, highWater: 500, lowWater: 500, ...over };
}

describe('advanceMarks', () => {
  it('tracks the best and worst price seen', () => {
    expect(advanceMarks(marks(), 503)).toMatchObject({ highWater: 503, lowWater: 500, stopPrice: 494, stopMoved: null });
    expect(advanceMarks(marks({ highWater: 503 }), 497)).toMatchObject({ highWater: 503, lowWater: 497 });
  });

  it('an ATR trail that starts after the partial waits for it, then trails the high-water and never loosens', () => {
    expect(advanceMarks(marks(), 506)).toMatchObject({ trailActive: false, stopPrice: 494 });
    expect(advanceMarks(marks({ partialDone: true, highWater: 505 }), 506)).toMatchObject({ trailActive: true, stopPrice: 501, stopMoved: 'TRAIL', highWater: 506 });
    const trailing = marks({ partialDone: true, trailActive: true, stopPrice: 501, highWater: 506 });
    expect(advanceMarks(trailing, 504)).toMatchObject({ stopPrice: 501, stopMoved: null });
    expect(advanceMarks(trailing, 508)).toMatchObject({ stopPrice: 503, stopMoved: 'TRAIL' });
  });

  it('a short trails the low-water', () => {
    const plan = cashPlan({ side: 'SELL', trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'ENTRY' }, atr: 5 });
    expect(advanceMarks(marks({ side: 'SELL', plan, stopPrice: 507.5 }), 495)).toMatchObject({ lowWater: 495, stopPrice: 500, trailActive: true, stopMoved: 'TRAIL' });
  });

  it('breakeven moves the stop to the entry once the move reaches atPct, once', () => {
    const plan = cashPlan({ trail: { kind: 'breakeven', atPct: 1 } });
    expect(advanceMarks(marks({ plan, stopPrice: 492.5 }), 504)).toMatchObject({ stopPrice: 492.5, stopMoved: null });
    expect(advanceMarks(marks({ plan, stopPrice: 492.5 }), 505)).toMatchObject({ stopPrice: 500, stopMoved: 'BREAKEVEN' });
    expect(advanceMarks(marks({ plan, stopPrice: 500, highWater: 505 }), 502)).toMatchObject({ stopPrice: 500, stopMoved: null });
  });

  it('no trail never moves the stop', () => {
    expect(advanceMarks(marks({ plan: cashPlan(), stopPrice: 492.5 }), 520)).toMatchObject({ stopPrice: 492.5, stopMoved: null, trailActive: false });
  });
});

describe('canConvertTargetToTrail (parent §7.3, spec §7.4)', () => {
  it('only once the stop locks in at least the target', () => {
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: 509, targetPrice: 510 })).toBe(false);
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: 510, targetPrice: 510 })).toBe(true);
    expect(canConvertTargetToTrail({ side: 'SELL', stopPrice: 486, targetPrice: 485 })).toBe(false);
    expect(canConvertTargetToTrail({ side: 'SELL', stopPrice: 484, targetPrice: 485 })).toBe(true);
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: null, targetPrice: 510 })).toBe(false);
  });
});
