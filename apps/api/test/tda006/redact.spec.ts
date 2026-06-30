import { redactProvenance } from '../../src/common/log/redact-provenance';

describe('redactProvenance', () => {
  it('strips anand + signal provenance keys, keeps the rest', () => {
    const out: any = redactProvenance({
      id: '1',
      symbol: 'X',
      scannerName: 's',
      scoreBreakdown: [],
      strategy: 'st',
      reason: 'r',
      confidenceScore: 9,
      keep: true,
    });
    expect(out).toEqual({ id: '1', symbol: 'X', keep: true });
  });

  it('is null/undefined safe', () => {
    expect(redactProvenance(null as any)).toBeNull();
    expect(redactProvenance(undefined as any)).toBeUndefined();
  });
});
