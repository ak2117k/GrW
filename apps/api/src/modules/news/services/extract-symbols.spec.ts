import { extractSymbols, hasNoCaseSignal, isTickerShaped, tokenise } from './extract-symbols';

/**
 * A stand-in for the instrument table. Every entry here IS a real listed
 * symbol — including the ordinary-looking words, which is the whole problem.
 */
const known = new Set([
  'KEI',
  'MOTHERSON',
  'HAL',
  'BDL',
  'NMDC',
  'VOLTAS',
  'SENSEX',
  'NIFTY',
  'RELIANCE',
  'TCS',
  // Real tickers that are also ordinary English words:
  'FOCUS',
  'PREMIUM',
  'VALUE',
  'MOMENTUM',
  'TECH',
  'JACKSON',
  'IT',
]);

describe('isTickerShaped', () => {
  it('accepts ALL-CAPS and Capitalised, rejects lower case', () => {
    expect(isTickerShaped('NMDC')).toBe(true);
    expect(isTickerShaped('Voltas')).toBe(true);
    expect(isTickerShaped('focus')).toBe(false);
    expect(isTickerShaped('premium')).toBe(false);
  });

  it('rejects mixed-case noise and too-short tokens', () => {
    expect(isTickerShaped('iPhone')).toBe(false);
    expect(isTickerShaped('McKinsey')).toBe(false);
    expect(isTickerShaped('IT')).toBe(false);
  });
});

describe('tokenise', () => {
  it('PRESERVES case — the case is the signal', () => {
    expect(tokenise('NMDC shares decline 4%')).toEqual(['NMDC', 'shares', 'decline', '4']);
  });

  it('keeps ampersands, which real tickers contain', () => {
    expect(tokenise('ARE&M reported')).toContain('ARE&M');
  });
});

describe('hasNoCaseSignal', () => {
  it('flags an all-caps headline, where case cannot distinguish anything', () => {
    expect(hasNoCaseSignal('MARKET WRAP: SENSEX FALLS AS OIL RISES')).toBe(true);
    expect(hasNoCaseSignal('Sensex falls as oil rises')).toBe(false);
  });
});

describe('extractSymbols', () => {
  it('finds the MID-CAPS the old 49-name list could never see', () => {
    // The bug this fixes: 82% of articles were untagged and the news sensor
    // could never fire for the names actually being traded.
    expect(extractSymbols('KEI Industries wins order', '', known)).toEqual(['KEI']);
    expect(extractSymbols('Motherson shares slip on margin miss', '', known)).toEqual(['MOTHERSON']);
    expect(extractSymbols('HAL bags Tejas contract', '', known)).toEqual(['HAL']);
    expect(extractSymbols('BDL rallies on defence push', '', known)).toEqual(['BDL']);
    expect(extractSymbols('NMDC shares decline 4% after Q1 results', '', known)).toEqual(['NMDC']);
  });

  describe('the false positives a case-insensitive match actually produced', () => {
    // Every headline below is real, from the news table, and every one was
    // mis-tagged before the case rule existed.

    it('does not tag PREMIUM in "debut at a 21% premium"', () => {
      expect(
        extractSymbols('Molbio Diagnostics IPO listing: Shares debut at a 21% premium', '', known),
      ).toEqual([]);
    });

    it('does not tag FOCUS in "in focus after Q1" — but still finds the company', () => {
      expect(
        extractSymbols('Voltas shares in focus after Q1 profit surges 52%', '', known),
      ).toEqual(['VOLTAS']);
    });

    it('does not tag MOMENTUM, VALUE or TECH used as ordinary words', () => {
      expect(extractSymbols('Top stocks to buy in this volatile momentum', '', known)).toEqual([]);
      expect(extractSymbols('Digital infrastructure opened markets to value', '', known)).toEqual([]);
      expect(extractSymbols('Tiger Global trims big tech bets', '', known)).toEqual([]);
    });

    it('does not tag JACKSON from "Jackson Hole"', () => {
      expect(extractSymbols('Fed uncertainty ahead of Jackson Hole', '', known)).toEqual([]);
    });
  });

  it('tags nothing in an ALL-CAPS headline rather than everything in it', () => {
    // Without this, the shape test admits every word — the opposite failure,
    // and a noisier one.
    expect(extractSymbols('MARKET WRAP: FOCUS ON PREMIUM VALUE STOCKS', '', known)).toEqual([]);
  });

  it('matches whole tokens only, never substrings', () => {
    // HALDIRAM must not tag HAL: that would attach unrelated news to a
    // defence position, and nothing downstream could tell it was wrong.
    expect(extractSymbols('Haldiram files for IPO', '', known)).toEqual([]);
    expect(extractSymbols('HALDIRAM files for IPO', '', known)).toEqual([]);
  });

  it('reads the summary too, de-duplicates, and keeps first-seen order', () => {
    expect(extractSymbols('RELIANCE up; TCS down', 'RELIANCE extends gains', known)).toEqual([
      'RELIANCE',
      'TCS',
    ]);
  });

  it('is empty-safe', () => {
    expect(extractSymbols('', '', known)).toEqual([]);
    expect(extractSymbols(null as never, undefined as never, known)).toEqual([]);
  });
});
