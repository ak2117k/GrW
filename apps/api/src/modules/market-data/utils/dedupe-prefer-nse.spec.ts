import { dedupePreferNse } from './dedupe-prefer-nse';

/**
 * Symbol search spans NSE + BSE and dedupes by TOKEN — but the same stock has a
 * DIFFERENT token on each exchange (RELIANCE = NSE 2885 vs BSE 500325), so both
 * survive and the user sees two identical-looking results. Picking the BSE one
 * keys the chart/trades/markers off the wrong token. Angel One shows one clean
 * NSE result per stock; this dedup matches that: drop the BSE listing when an NSE
 * listing exists for the same bare symbol, keep everything else.
 */
describe('dedupePreferNse', () => {
  const row = (symbol: string, exchange: string, token: string) => ({ symbol, exchange, token });

  it('drops the BSE listing when the same stock exists on NSE', () => {
    const out = dedupePreferNse([
      row('RELIANCE-EQ', 'NSE', '2885'),
      row('RELIANCE', 'BSE', '500325'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].exchange).toBe('NSE');
    expect(out[0].token).toBe('2885');
  });

  it('matches NSE `-EQ` symbols to the bare BSE symbol', () => {
    // The NSE series suffix must be normalised away, or the two never match.
    const out = dedupePreferNse([row('TCS-EQ', 'NSE', '11536'), row('TCS', 'BSE', '532540')]);
    expect(out.map((r) => r.exchange)).toEqual(['NSE']);
  });

  it('keeps a BSE-only stock (no NSE listing to prefer)', () => {
    const out = dedupePreferNse([row('BSEONLY', 'BSE', '999001')]);
    expect(out).toHaveLength(1);
    expect(out[0].exchange).toBe('BSE');
  });

  it('leaves NFO / MCX / index rows untouched', () => {
    const rows = [
      row('RELIANCE-EQ', 'NSE', '2885'),
      row('RELIANCE25JUL3000CE', 'NFO', '40001'), // option — bare symbol differs, never collides
      row('CRUDEOIL', 'MCX', '488290'),
      row('NIFTY', 'NSE', '99926000'), // index
    ];
    expect(dedupePreferNse(rows)).toHaveLength(4);
  });

  it('preserves order and keeps NSE-only + unrelated rows', () => {
    const out = dedupePreferNse([
      row('INFY-EQ', 'NSE', '1594'),
      row('SBIN-EQ', 'NSE', '3045'),
      row('SBIN', 'BSE', '500112'),
    ]);
    expect(out.map((r) => `${r.exchange}:${r.token}`)).toEqual(['NSE:1594', 'NSE:3045']);
  });

  it('is order-independent — drops BSE even when it appears before NSE', () => {
    const out = dedupePreferNse([row('WIPRO', 'BSE', '507685'), row('WIPRO-EQ', 'NSE', '3787')]);
    expect(out.map((r) => r.exchange)).toEqual(['NSE']);
  });

  it('is total — tolerates empty and odd rows', () => {
    expect(dedupePreferNse([])).toEqual([]);
    expect(dedupePreferNse([row('', 'BSE', '1')])).toHaveLength(1);
  });
});
