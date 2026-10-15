// apps/api/src/modules/sentinel-executor/domain/stored-trigger.spec.ts
import { parseStoredTrigger } from './stored-trigger';

/** Byte-identical to trade-sentinel's STORED_TRIGGER_FIXTURE (ruling R17 — keep the two in sync). */
const STORED_TRIGGER_FIXTURE = {
  v: 1,
  instrument: 'UNDERLYING',
  op: 'BELOW',
  price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  seen: { price: 8951, at: '2026-10-13T16:59:58.000Z' },
};

describe('parseStoredTrigger (wire contract with trade-sentinel)', () => {
  it('reads the contract fixture', () => {
    expect(parseStoredTrigger(STORED_TRIGGER_FIXTURE)).toEqual({
      kind: 'trigger',
      trigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' } },
    });
  });

  it('PREMIUM with watch null', () => {
    expect(parseStoredTrigger({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null })).toMatchObject({
      kind: 'trigger', trigger: { watch: null },
    });
  });

  it('carries the sentinel-side problem through', () => {
    expect(parseStoredTrigger({ v: 1, problem: 'price is not a positive number' })).toEqual({ kind: 'problem', problem: 'price is not a positive number' });
  });

  it.each([
    [null], ['x'], [[1]], [{ v: 2, instrument: 'PREMIUM', op: 'BELOW', price: 1 }],
    [{ v: 1, instrument: 'SPOT', op: 'BELOW', price: 1 }], [{ v: 1, instrument: 'PREMIUM', op: 'DOWN', price: 1 }],
    [{ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: -1 }], [{ v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 1, watch: { token: 5 } }],
  ])('%j is a problem, never a throw', (json) => {
    expect(parseStoredTrigger(json).kind).toBe('problem');
  });
});
