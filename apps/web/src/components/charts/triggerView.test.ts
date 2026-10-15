// apps/web/src/components/charts/triggerView.test.ts
import { describe, expect, it } from 'vitest';
import { armedForTracker, armedTriggerLine, triggerHistoryLine } from './triggerView';
import type { SentinelTriggerRow } from '@/hooks/useSentinelTriggers';

const row = (over: Partial<SentinelTriggerRow> = {}): SentinelTriggerRow => ({
  id: 'trg1', trackerId: 't1', verdictId: 'v1', symbol: 'CRUDEOIL19NOV268950CE', instrument: 'UNDERLYING', op: 'BELOW',
  price: 8930, watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951, status: 'ARMED', reason: null,
  armedAt: '2026-10-13T17:03:00.000Z', endedAt: null, firedAt: null, firedPrice: null, firedTickAt: null,
  createdAt: '2026-10-13T17:03:00.000Z', ...over,
});

describe('triggerView', () => {
  it('the armed line the owner reads (spec §6)', () => {
    expect(armedTriggerLine(row())).toBe('auto-exit if CRUDEOIL19NOV26FUT < 8930, armed 22:33 IST');
    expect(armedTriggerLine(row({ op: 'ABOVE', price: 9000 }))).toBe('auto-exit if CRUDEOIL19NOV26FUT > 9000, armed 22:33 IST');
    expect(armedTriggerLine(row({ status: 'FIRED' }))).toBeNull();
  });

  it('armedForTracker picks the ARMED row of that tracker only', () => {
    expect(armedForTracker([row({ status: 'SUPERSEDED' }), row({ id: 'trg2' }), row({ id: 'x', trackerId: 't2' })], 't1')?.id).toBe('trg2');
    expect(armedForTracker([], 't1')).toBeNull();
  });

  it('history lines name the outcome', () => {
    expect(triggerHistoryLine(row({ status: 'FIRED', firedPrice: 8927.5, firedAt: '2026-10-13T17:11:07.000Z' })))
      .toBe('FIRED at 8927.5 (22:41 IST) — < 8930 on CRUDEOIL19NOV26FUT');
    expect(triggerHistoryLine(row({ status: 'REJECTED', reason: 'LOOSENS' }))).toBe('REJECTED: LOOSENS — < 8930 on CRUDEOIL19NOV26FUT');
    expect(triggerHistoryLine(row({ status: 'REJECTED', reason: 'MALFORMED: x', instrument: null, op: null, price: null, watchSymbol: null })))
      .toBe('REJECTED: MALFORMED: x');
  });
});
