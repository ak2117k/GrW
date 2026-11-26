import { instrumentHits, prefilter } from './prefilter';
import { normalise } from './text';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'BSE-EQ', 'MCX-EQ', 'IDEA-EQ', 'RAIN-EQ', 'BEL-EQ']);
const names = (text: string) => prefilter(text, vocab).underlyings;

describe('pre-filter: ambiguous symbols beside a price-level phrase (2026-11-26 BSE post)', () => {
  it('"BSE CASH ABOVE 3860" names BSE, and the full post passes', () => {
    expect(names('BSE CASH ABOVE 3860')).toEqual(['BSE']);
    expect(prefilter('BSE\n\nBSE CASH ABOVE 3860\n\nsupport 3760\n\nview 4000', vocab)).toMatchObject({ pass: true, reason: 'ok', underlyings: ['BSE'] });
  });

  it('"BSE 3894 modify support 3870" names BSE (a number follows)', () => {
    expect(names('BSE 3894 modify support 3870')).toEqual(['BSE']);
  });

  it('"listed on BSE and NSE" names nothing', () => {
    expect(names('listed on BSE and NSE')).toEqual([]);
  });

  it('"MCX GOLD 72000 target" names GOLD only (MCX stays an exchange word before a commodity)', () => {
    expect(names('MCX GOLD 72000 target')).toEqual(['GOLD']);
  });

  it('an ambiguous word followed by another instrument within 2 tokens does not count ("trade IDEA buy NIFTY")', () => {
    expect(names('Trade IDEA: BUY NIFTY 24000 CE ABOVE 120 SL 100')).toEqual(['NIFTY']);
  });

  it('a level word that is itself ambiguous is never the instrument ("SL 100", "BUY 3860")', () => {
    const v = buildVocabulary(['SL-EQ', 'BUY-EQ', 'BSE-EQ']);
    expect(prefilter('BSE BUY 3860 SL 3760', v).underlyings).toEqual(['BSE']);
  });

  it('still needs a level word or number: "Rain expected today" is not RAIN', () => {
    expect(names('Rain expected today, buy umbrella 2 for 300')).toEqual([]);
  });

  it('the contract rule still holds: "BEL 300 CE" names BEL', () => {
    expect(instrumentHits(normalise('BEL 300 CE buy 5 sl 3', vocab).tokens, vocab).map((h) => h.name)).toEqual(['BEL']);
  });
});
