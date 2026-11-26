import { indexPacket, validateReading } from './reading-validate';

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

describe('validateReading: reasonCode (2026-11-26)', () => {
  it('keeps a listed reasonCode on NOT_CHECKABLE only; null / off-list / other verdicts carry none', () => {
    const r = validateReading(
      reply([
        claim({ verdict: 'NOT_CHECKABLE', evidence: [], reasonCode: 'FORWARD_LOOKING' }),
        claim({ verdict: 'NOT_CHECKABLE', evidence: [], reasonCode: null }),
        claim({ verdict: 'NOT_CHECKABLE', evidence: [], reasonCode: 'BECAUSE' }),
        claim({ verdict: 'UNCLEAR', evidence: [], reasonCode: 'STALE' }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.claims.map((c) => c.reasonCode)).toEqual(['FORWARD_LOOKING', undefined, undefined, undefined]);
  });
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

describe('validateReading — blank strings (final review #4)', () => {
  it.each([
    ['text', claim({ text: '   ' })],
    ['subject', claim({ subject: ' \t ' })],
  ])('rejects a whitespace-only claim %s', (_f, c) => {
    expect(validateReading(reply([c])).ok).toBe(false);
  });

  it('rejects a whitespace-only summary', () => {
    expect(validateReading(reply([], { summary: '  ' }))).toEqual({ ok: false, reason: expect.stringContaining('summary') });
  });

  it.each([
    ['fact', { fact: '  ', value: '0.4', source: 'quotes' }],
    ['value', { fact: 'NIFTY change', value: ' ', source: 'quotes' }],
  ])('rejects a whitespace-only evidence %s', (_f, e) => {
    expect(validateReading(reply([claim({ evidence: [e] })])).ok).toBe(false);
  });
});

describe('validateReading — evidence checked against the packet (final review #4)', () => {
  const PACKET = {
    at: '2026-11-25T04:00:00.000Z',
    marketPulse: {
      indices: { status: 'present', source: 'q', value: { NIFTY: { ltp: 24_350.5, changePercent: 0.4 } } },
      breadth: { status: 'unavailable', source: 'b', reason: 'timed out after 3000 ms' },
      sectors: { status: 'present', source: 's', value: [{ sector: 'IT', changePercent: -1.234 }] },
    },
    instruments: {
      NIFTY: { chain: { status: 'present', source: 'c', value: { pcr: 0.92, maxPain: 24300 } } },
      SBIN: { context: { status: 'unavailable', source: 'i', reason: 'reader build limit' } },
    },
    channelRecent: { status: 'present', source: 'ch', value: [] },
    todayNotes: { status: 'present', source: 'n', value: [] },
  };
  const ev = (value: string, source = 'marketPulse.indices') => ({ fact: 'f', value, source });
  const one = (evidence: unknown[], verdict = 'CONFIRMED') => {
    const r = validateReading(reply([claim({ verdict, evidence })]), PACKET);
    if (!r.ok) throw new Error(r.reason);
    return r.reply.claims[0];
  };

  it('keeps CONFIRMED when a value is in the packet (commas, ₹, %, + and 2 dp normalised)', () => {
    expect(one([ev('24,350.50')]).verdict).toBe('CONFIRMED');
    expect(one([ev('₹24350.5')]).verdict).toBe('CONFIRMED');
    expect(one([ev('+0.4%')]).verdict).toBe('CONFIRMED');
    expect(one([ev('-1.23%', 'marketPulse.sectors')]).verdict).toBe('CONFIRMED');
    expect(one([ev('0.92', 'instruments.NIFTY.chain')]).evidenceMissing).toBeUndefined();
  });

  it('downgrades to UNCLEAR + evidenceMissing when no evidence value is anywhere in the packet', () => {
    const c = one([ev('24,500'), ev('1.7%')]);
    expect(c.verdict).toBe('UNCLEAR');
    expect(c.evidenceMissing).toBe(true);
    expect(one([ev('99')], 'CONTRADICTED')).toMatchObject({ verdict: 'UNCLEAR', evidenceMissing: true });
  });

  it('downgrades when an evidence source names an unavailable block (full path, bare pulse name, failed instrument)', () => {
    expect(one([ev('0.4', 'marketPulse.breadth')])).toMatchObject({ verdict: 'UNCLEAR', evidenceMissing: true });
    expect(one([ev('0.4', 'breadth')])).toMatchObject({ verdict: 'UNCLEAR', evidenceMissing: true });
    expect(one([ev('0.4', 'instruments.SBIN.chain')])).toMatchObject({ verdict: 'UNCLEAR', evidenceMissing: true });
    // One good item does not rescue an item that cites an unavailable block.
    expect(one([ev('0.4'), ev('0.4', 'marketPulse.breadth')])).toMatchObject({ verdict: 'UNCLEAR', evidenceMissing: true });
  });

  it('word values are matched in the packet text; NOT_CHECKABLE is left alone', () => {
    expect(one([ev('IT', 'marketPulse.sectors')]).verdict).toBe('CONFIRMED');
    expect(one([ev('nowhere words')], 'NOT_CHECKABLE').verdict).toBe('NOT_CHECKABLE');
  });

  it('without a packet only the old checks apply (callers that have none)', () => {
    const r = validateReading(reply([claim({ evidence: [ev('99')] })]));
    expect(r.ok && r.reply.claims[0].verdict).toBe('CONFIRMED');
  });

  it('indexPacket: statusOf resolves dotted paths', () => {
    const idx = indexPacket(PACKET);
    expect(idx.statusOf('marketPulse.indices')).toBe('present');
    expect(idx.statusOf('marketPulse.breadth')).toBe('unavailable');
    expect(idx.statusOf('instruments.NIFTY.chain')).toBe('present');
    expect(idx.statusOf('nonsense')).toBeNull();
  });
});
