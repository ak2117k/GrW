import { scoreSymbolMatch, rankSymbolMatches } from './rank-symbol-matches';

/**
 * Symbol search should feel like Angel One's: type a few letters and the obvious
 * pick is #1. That means RELEVANCE RANKING, not the old substring-in-arrival-order
 * list — exact › symbol-prefix › symbol-substring › name › fuzzy-subsequence, all
 * case-insensitive, with ties broken toward NSE / the liquid -EQ series / shorter
 * symbols. These tests pin that ordering.
 */
describe('scoreSymbolMatch', () => {
  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = scoreSymbolMatch('RELIANCE', 'RELIANCE-EQ');
    const prefix = scoreSymbolMatch('REL', 'RELIANCE-EQ');
    const substr = scoreSymbolMatch('LIAN', 'RELIANCE-EQ');
    const subseq = scoreSymbolMatch('RLNC', 'RELIANCE-EQ'); // letters in order, gaps
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it('is case-insensitive and ignores the NSE series suffix', () => {
    expect(scoreSymbolMatch('reliance', 'RELIANCE-EQ')).toBe(scoreSymbolMatch('RELIANCE', 'RELIANCE'));
  });

  it('matches on company name at a lower rank than the symbol', () => {
    const bySym = scoreSymbolMatch('VBL', 'VBL-EQ', 'VARUN BEVERAGES');
    const byName = scoreSymbolMatch('VARUN', 'VBL-EQ', 'VARUN BEVERAGES');
    expect(bySym).toBeGreaterThan(byName);
    expect(byName).toBeGreaterThan(0);
  });

  it('scores a shorter symbol higher within the same match level', () => {
    // Both are prefix matches for "TC"; the shorter symbol should win.
    expect(scoreSymbolMatch('TC', 'TCS-EQ')).toBeGreaterThan(scoreSymbolMatch('TC', 'TCPLPACK-EQ'));
  });

  it('returns 0 for no match (excluded from results)', () => {
    expect(scoreSymbolMatch('ZZZZ', 'RELIANCE-EQ')).toBe(0);
    expect(scoreSymbolMatch('', 'RELIANCE-EQ')).toBe(0);
  });
});

describe('rankSymbolMatches', () => {
  const rows = [
    { symbol: 'RELIANCE-EQ', exch_seg: 'NSE', token: '2885', name: 'RELIANCE' },
    { symbol: 'RELIANCE', exch_seg: 'BSE', token: '500325', name: 'RELIANCE' },
    { symbol: 'RELIGARE-EQ', exch_seg: 'NSE', token: '11', name: 'RELIGARE' },
    { symbol: 'HDFCBANK-EQ', exch_seg: 'NSE', token: '1333', name: 'HDFC BANK' },
  ];

  it('puts the best match first — "REL" → RELIANCE (NSE) ahead of RELIGARE', () => {
    const out = rankSymbolMatches('REL', rows, 25);
    expect(out[0].symbol).toBe('RELIANCE-EQ');
    expect(out.map((r) => r.symbol)).toContain('RELIGARE-EQ'); // still matches, ranked lower
  });

  it('prefers NSE over BSE on an otherwise-equal match', () => {
    const out = rankSymbolMatches('RELIANCE', rows, 25);
    expect(out[0].exch_seg).toBe('NSE'); // both exact; NSE wins the tie
  });

  it('excludes non-matches and respects the limit', () => {
    const out = rankSymbolMatches('HDFC', rows, 1);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('HDFCBANK-EQ');
  });

  it('is total on empty/odd input', () => {
    expect(rankSymbolMatches('REL', [], 25)).toEqual([]);
    expect(rankSymbolMatches('', rows, 25)).toEqual([]);
  });
});
