import { validateReading } from './reading-validate';

const claim = (over: Record<string, unknown> = {}) => ({
  text: 'nifty strong',
  subject: 'NIFTY',
  bias: 'BULL',
  horizon: 'INTRADAY',
  claimType: 'DIRECTION',
  verdict: 'CONFIRMED',
  evidence: [{ fact: 'NIFTY change', value: '+0.4%', source: 'quotes' }],
  ...over,
});
const reply = (claims: unknown[], over: Record<string, unknown> = {}) => ({
  kind: 'INFO',
  scope: 'MARKET',
  claims,
  call: null,
  summary: 'one line',
  ...over,
});

describe('validateReading', () => {
  it('downgrades a CONFIRMED claim with no evidence to UNCLEAR', () => {
    const r = validateReading(reply([claim({ verdict: 'CONFIRMED', evidence: [] })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.claims[0].verdict).toBe('UNCLEAR');
    expect(r.reply.claims[0].evidenceMissing).toBe(true);
  });

  it('downgrades a CONTRADICTED claim with no evidence to UNCLEAR', () => {
    const r = validateReading(reply([claim({ verdict: 'CONTRADICTED', evidence: [] })]));
    expect(r.ok && r.reply.claims[0].verdict).toBe('UNCLEAR');
    expect(r.ok && r.reply.claims[0].evidenceMissing).toBe(true);
  });

  it('keeps NOT_CHECKABLE with empty evidence', () => {
    const r = validateReading(reply([claim({ verdict: 'NOT_CHECKABLE', evidence: [] })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.claims[0].verdict).toBe('NOT_CHECKABLE');
    expect(r.reply.claims[0]).not.toHaveProperty('evidenceMissing');
  });

  it('normalises subject to trimmed uppercase (downstream matching is exact)', () => {
    const r = validateReading(reply([claim({ subject: '  Nifty ' }), claim({ subject: 'metal' })]));
    expect(r.ok && r.reply.claims.map((c) => c.subject)).toEqual(['NIFTY', 'METAL']);
  });

  it('rejects an unknown kind', () => {
    const r = validateReading(reply([], { kind: 'GOSSIP' }));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/kind/) });
  });

  it('rejects a reply that is not an object', () => {
    expect(validateReading('hello').ok).toBe(false);
    expect(validateReading(null).ok).toBe(false);
  });

  it('rejects a claim with a bad verdict', () => {
    const r = validateReading(reply([claim({ verdict: 'MAYBE' })]));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/verdict/) });
  });

  it('accepts a CALL with a call payload', () => {
    const call = { underlying: 'NIFTY', side: 'BUY', optionType: 'CE', strike: 26000, entryLow: 120, entryHigh: 125, stopLoss: 100, targets: [150, 180] };
    const r = validateReading(reply([], { kind: 'CALL', scope: 'INSTRUMENT', call }));
    expect(r.ok && r.reply.call).toEqual(call);
  });

  it('rejects a call with a bad side', () => {
    const call = { underlying: 'NIFTY', side: 'HOLD', optionType: null, strike: null, entryLow: null, entryHigh: null, stopLoss: null, targets: [] };
    const r = validateReading(reply([], { kind: 'CALL', call }));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/side/) });
  });

  it('accepts the 2026-11-25 Stock Gainers reading', () => {
    const c = {
      text: 'stocks weak, index strong',
      subject: 'MARKET',
      bias: 'CAUTION',
      horizon: 'INTRADAY',
      claimType: 'RELATIVE_BREADTH',
      verdict: 'CONFIRMED',
      evidence: [
        { fact: 'NIFTY change', value: '+0.4%', source: 'quotes' },
        { fact: 'A/D', value: '0.8', source: 'breadth' },
      ],
    };
    const r = validateReading({ kind: 'INFO', scope: 'MARKET', claims: [c], call: null, summary: 'Breadth lags the index.' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.claims[0]).toEqual(c);
    expect(r.reply.call).toBeNull();
  });
});
