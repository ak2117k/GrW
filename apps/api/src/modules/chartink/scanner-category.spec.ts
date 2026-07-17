import { categorizeScannerByName, ANAND_SWING, OTHER } from './scanner-category';

/**
 * A Chartink scanner named "ANAND SWING …" is a swing scanner, but scanner rows
 * default to OTHER and nothing tagged them — so the swing dual-track
 * (`chartink-process.service.ts`, gated on `category === 'ANAND_SWING'`) never
 * fired for it. One such scanner fired 345 times in prod and produced zero swing
 * entries. This function tags a scanner from its name at creation time so the
 * manual step can't be forgotten again.
 */
describe('categorizeScannerByName', () => {
  it('tags the real swing scanner name as ANAND_SWING', () => {
    expect(categorizeScannerByName('ANAND SWING 1ST JUNE 26')).toBe(ANAND_SWING);
  });

  it('is case-insensitive', () => {
    expect(categorizeScannerByName('anand swing july')).toBe(ANAND_SWING);
    expect(categorizeScannerByName('Anand Swing Whatever')).toBe(ANAND_SWING);
  });

  it('tolerates extra internal whitespace between the words', () => {
    // Chartink names are user-typed; "ANAND  SWING" (double space) is the same scanner.
    expect(categorizeScannerByName('ANAND   SWING 2ND')).toBe(ANAND_SWING);
  });

  it('does NOT tag a non-swing ANAND scanner', () => {
    // The other prod scanner. It is ANAND-branded but not a swing scanner, and
    // must stay OTHER so it does not start creating swing entries.
    expect(categorizeScannerByName('ANAND 200% PROFIT COMP BULLISH')).toBe(OTHER);
  });

  it('does not tag unrelated scanners', () => {
    expect(categorizeScannerByName('Short term breakouts')).toBe(OTHER);
    expect(categorizeScannerByName('SWING TRADES')).toBe(OTHER); // "swing" without "anand"
  });

  it('is total — odd input falls back to OTHER, never throws', () => {
    expect(categorizeScannerByName('')).toBe(OTHER);
    expect(categorizeScannerByName(undefined as never)).toBe(OTHER);
    expect(categorizeScannerByName(null as never)).toBe(OTHER);
  });
});
