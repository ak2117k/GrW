import {
  STORED_TRIGGER_FIXTURE,
  exitTriggerRecord,
  parseExitTriggerProposal,
} from './exit-trigger-proposal';

describe('parseExitTriggerProposal', () => {
  it('absent key = a pre-v6 reply, left untouched', () => {
    expect(parseExitTriggerProposal({ verdict: 'HOLD' })).toEqual({ kind: 'absent' });
  });

  it('explicit null = no defensible level', () => {
    expect(parseExitTriggerProposal({ exitTrigger: null })).toEqual({ kind: 'none' });
  });

  it('accepts the exact shape', () => {
    expect(parseExitTriggerProposal({ exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } })).toEqual({
      kind: 'proposal',
      proposal: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 },
    });
  });

  it.each([
    ['a string', 'BELOW 8930', /not an object/],
    ['an array', [8930], /not an object/],
    ['an unknown instrument', { instrument: 'SPOT', op: 'BELOW', price: 1 }, /instrument/],
    ['a lowercase op', { instrument: 'PREMIUM', op: 'below', price: 1 }, /op/],
    ['a string price (the CLI cannot enforce the schema)', { instrument: 'PREMIUM', op: 'BELOW', price: '120' }, /price/],
    ['a zero price', { instrument: 'PREMIUM', op: 'BELOW', price: 0 }, /price/],
    ['a NaN price', { instrument: 'PREMIUM', op: 'BELOW', price: Number.NaN }, /price/],
    ['an extra field', { instrument: 'PREMIUM', op: 'BELOW', price: 1, note: 'x' }, /unexpected field/],
  ])('rejects %s as malformed, never throws', (_label, value, problem) => {
    const r = parseExitTriggerProposal({ exitTrigger: value });
    expect(r.kind).toBe('malformed');
    expect((r as { problem: string }).problem).toMatch(problem);
  });
});

describe('exitTriggerRecord', () => {
  const tick = {
    ltp: 212.5,
    underlyingLtp: 8951,
    underlyingLtpAt: '2026-10-13T16:59:58.000Z',
    underlyingRef: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  };

  it('UNDERLYING: carries the resolved watch instrument and what the judge saw', () => {
    const rec = exitTriggerRecord(
      { verdict: 'EXIT_ARMED', exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } },
      tick,
    );
    expect(rec).toEqual(STORED_TRIGGER_FIXTURE);
  });

  it('PREMIUM: no watch (the executor uses the tracker contract), seen = the premium', () => {
    expect(
      exitTriggerRecord({ verdict: 'HOLD', exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 180 } }, tick),
    ).toEqual({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null, seen: { price: 212.5, at: null } });
  });

  it('UNDERLYING with no resolved underlying keeps watch null (the executor rejects NO_WATCH_TARGET)', () => {
    const rec = exitTriggerRecord(
      { verdict: 'HOLD', exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } },
      { ...tick, underlyingRef: null, underlyingLtp: null, underlyingLtpAt: null },
    );
    expect(rec?.watch).toBeNull();
  });

  it('a malformed proposal is persisted as a problem so it is recorded, not lost', () => {
    expect(exitTriggerRecord({ verdict: 'HOLD', exitTrigger: null, exitTriggerProblem: 'price is not a positive number' }, tick))
      .toEqual({ v: 1, problem: 'price is not a positive number' });
  });

  it.each(['EXIT_NOW', 'ESCALATE'])('%s never carries a trigger (spec §3.1: ignored)', (verdict) => {
    expect(exitTriggerRecord({ verdict, exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 1 } }, tick)).toBeNull();
  });

  it('null / absent proposal persists nothing', () => {
    expect(exitTriggerRecord({ verdict: 'HOLD', exitTrigger: null }, tick)).toBeNull();
    expect(exitTriggerRecord({ verdict: 'HOLD' }, tick)).toBeNull();
  });
});
