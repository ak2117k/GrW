import { inferExpiry } from './expiry';
import { parseSignal } from './rule-parser';
import { expiryHintOfText, normalise } from './text';
import { buildVocabulary } from './vocabulary';

/**
 * Fix 3 (telegram audit 2026-11-28): Mr P Investments 2026-11-27 09:19 IST "Btst / Positional (December 29) …
 * Nifty 25700 pe Above 330" was parsed with NO expiry and matched to the 01-Dec weekly, so "above 330" could
 * never fire. The named expiry must be read from the post, and a named expiry that is not listed must not fall
 * back to another contract.
 */

const vocab = buildVocabulary(['RELIANCE-EQ', 'SBIN-EQ']);
const hint = (t: string) => expiryHintOfText(t);

describe('expiry phrases in the post text', () => {
  it.each([
    ['Btst / Positional (December 29)\n\nNifty 25700 pe\nAbove 330', { day: 29, month: 12, year: null }],
    ['NIFTY 25700 PE 29 Dec above 330', { day: 29, month: 12, year: null }],
    ['NIFTY 25700 PE 29th Dec above 330', { day: 29, month: 12, year: null }],
    ['NIFTY 25700 PE 29DEC above 330', { day: 29, month: 12, year: null }],
    ['NIFTY 25700 PE 29 December 2026 above 330', { day: 29, month: 12, year: 2026 }],
    ['NIFTY 25700 PE Dec 29 above 330', { day: 29, month: 12, year: null }],
    ['NIFTY 25700 PE December 29th, 2026 above 330', { day: 29, month: 12, year: 2026 }],
    ['📈𝗕𝘂𝘆 NIFTY 25850 C𝗘( 01 DEC𝗘𝘅)', { day: 1, month: 12, year: null }],
    ['📈𝗕𝘂𝘆 Sensex 83700 P𝗘(26 DEC𝗘𝘅)', { day: 26, month: 12, year: null }],
    ['NIFTY 25700 PE Dec expiry above 330', { day: null, month: 12, year: null }],
    ['BUY CRUDEOIL 8050 CE NEAR LEVEL - 292 📣EXPIRY -  DECEMBER', { day: null, month: 12, year: null }],
    ['BUY GOLD 125000 CE 📣EXPIRY - NOVEMBER', { day: null, month: 11, year: null }],
    ['KPIT TECH 540CE CMP 25-26 For 35++ November Expiry', { day: null, month: 11, year: null }],
    ['NIFTY DEC 25700 PE above 330', { day: null, month: 12, year: null }],
    ['NIFTY 25700 PE monthly expiry above 330', { day: null, month: 0, year: null, relative: 'MONTHLY' }],
    ['NIFTY MONTHLY 25700 PE above 330', { day: null, month: 0, year: null, relative: 'MONTHLY' }],
    ['NIFTY 25700 PE weekly expiry above 330', { day: null, month: 0, year: null, relative: 'WEEKLY' }],
    ['NIFTY 25700 PE next week expiry above 330', { day: null, month: 0, year: null, relative: 'NEXT' }],
    ['NIFTY 25700 PE next expiry above 330', { day: null, month: 0, year: null, relative: 'NEXT' }],
    ['NIFTY 25700 PE this expiry above 330', { day: null, month: 0, year: null, relative: 'CURRENT' }],
    ['NIFTY 25700 PE current week expiry above 330', { day: null, month: 0, year: null, relative: 'CURRENT' }],
    ['Nifty 25700 PE agle hafte ki expiry 330 ke upar', { day: null, month: 0, year: null, relative: 'NEXT' }],
    ['Nifty 25700 PE is expiry 330 ke upar', { day: null, month: 0, year: null, relative: 'CURRENT' }],
    ['Nifty 25700 PE mahine ki expiry 330 ke upar', { day: null, month: 0, year: null, relative: 'MONTHLY' }],
  ])('%s', (text, want) => {
    expect(hint(text)).toEqual(want);
    expect(normalise(text, vocab).expiry).toEqual(want);
  });

  it.each([
    'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160/200',
    'Join our monthly plan, fees 4999',
    'Hold for next week, target 400',
    'BANKNIFTY 52000 PE buy 300-310 sl 270 target 350 400',
    'NIFTY 25700 PE you may 20 points more',
  ])('no expiry in "%s"', (text) => {
    expect(hint(text)).toBeNull();
  });

  it('the day is not read as an entry once lifted out ("26 DEC𝗘𝘅" was entry 26)', () => {
    const text = '📈𝗕𝘂𝘆 Sensex 83700 P𝗘(26 DEC𝗘𝘅)\n\n➡️𝗕𝘂𝘆:- 180/\n\n🔫𝗧𝗮𝗿𝗴𝗲𝘁:- your';
    expect(parseSignal(text, vocab)?.entryLow ?? null).not.toBe(26);
  });

  it('the real Mr P 2026-11-27 09:19 post: rule-parsed with its expiry and its stop', () => {
    const text =
      'Btst / Positional (December 29)\n\nNifty 25700 pe\nAbove 330 \nStop loss- 300\n\nLot size- 65\nTarget- 360, 390, 530++\n\n' +
      '📢 For Stock Market & Third-Party Products Risks, Disclosures and Disclaimer, Standard Rationale, Investor Charter.\nPlease visit our website: https://mrpinvestments.in/ and read everything.';
    expect(parseSignal(text, vocab)).toMatchObject({
      underlying: 'NIFTY', instrumentKind: 'PE', strike: 25700, side: 'BUY', entryType: 'ABOVE', entryLow: 330, sl: 300, targets: [360, 390, 530], qty: 65,
      expiryHint: { day: 29, month: 12, year: null },
    });
  });

  it('"2 LOTS" is still a quantity', () => {
    expect(parseSignal('BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140 2 LOTS', vocab)).toMatchObject({ sl: 100, qty: 2 });
  });

  it('a month-first date keeps the call parseable', () => {
    const text = 'BUY NIFTY 25700 PE December 29 ABOVE 330 SL 300 TGT 360 390';
    const p = parseSignal(text, vocab);
    expect(p).toMatchObject({ underlying: 'NIFTY', strike: 25700, instrumentKind: 'PE', entryLow: 330, sl: 300, targets: [360, 390], expiryHint: { day: 29, month: 12, year: null } });
  });
});

describe('expiry inference from a named expiry', () => {
  // Fri 2026-11-27 09:19 IST
  const at = new Date('2026-11-27T03:49:35Z');
  const niftyListed = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-26', '2027-03-30'];

  it('Mr P "December 29" → the 29-Dec monthly, not the 01-Dec weekly', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: 29, month: 12, year: null }, at, niftyListed)).toEqual({ expiry: '2026-12-29', source: 'message' });
  });
  it('a named day that is not listed is a mismatch, never the next listed one', () => {
    // Fri 04-Dec: 01-Dec is 3 days earlier, 08-Dec is later.
    const r = inferExpiry('NIFTY', 'PE', { day: 4, month: 12, year: null }, at, niftyListed);
    expect(r.expiry).toBe('2026-12-04');
    expect(r.source).toBe('message');
    expect(r.mismatch).toMatch(/2026-12-04.*not listed/);
    expect(r.expiryShifted).toBeUndefined();
  });
  it('holiday shift: a named Tuesday with the one listed expiry on the Monday before is that expiry', () => {
    const listed = ['2026-12-01', '2026-12-08', '2026-12-14', '2026-12-22'];
    expect(inferExpiry('NIFTY', 'PE', { day: 15, month: 12, year: null }, at, listed)).toEqual({
      expiry: '2026-12-14', source: 'message', expiryShifted: { named: '2026-12-15', listed: '2026-12-14' },
    });
  });
  it('holiday shift: a 3-day gap is rejected', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: 18, month: 12, year: null }, at, ['2026-12-15', '2026-12-22']);
    expect(r).toMatchObject({ expiry: '2026-12-18', mismatch: expect.stringMatching(/not listed/) });
    expect(r.expiryShifted).toBeUndefined();
  });
  it('holiday shift: two candidates are rejected', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: 17, month: 12, year: null }, at, ['2026-12-15', '2026-12-16', '2026-12-22']);
    expect(r).toMatchObject({ expiry: '2026-12-17', mismatch: expect.stringMatching(/not listed/) });
    expect(r.expiryShifted).toBeUndefined();
  });
  it('holiday shift: never across a month', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: 1, month: 1, year: 2027 }, at, ['2026-12-31', '2027-01-05']);
    expect(r.mismatch).toMatch(/2027-01-01/);
  });
  it('SENSEX "26 DEC" (a Saturday) stays unresolved although 24-Dec is listed (real master 2026-11-28)', () => {
    const sensex = ['2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31'];
    const nov26 = new Date('2026-11-26T03:58:32Z');
    const r = inferExpiry('SENSEX', 'PE', { day: 26, month: 12, year: null }, nov26, sensex);
    expect(r).toMatchObject({ expiry: '2026-12-26', mismatch: expect.stringMatching(/not listed/) });
    expect(r.expiryShifted).toBeUndefined();
  });
  it('a named day already expired (gone from the master) is a mismatch', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: 24, month: 11, year: null }, at, niftyListed);
    expect(r.mismatch).toMatch(/2026-11-24 has already expired/);
  });
  it('a listed day named after the 15:15 cutoff on that day stays that contract', () => {
    const late = new Date('2026-11-26T09:56:02Z'); // 15:26 IST on the SENSEX 26-Nov expiry
    expect(inferExpiry('SENSEX', 'CE', { day: 26, month: 11, year: 2026 }, late, ['2026-11-26', '2026-12-03'])).toEqual({ expiry: '2026-11-26', source: 'message' });
  });
  it('month only → that month’s last listed expiry (the monthly)', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 12, year: null }, at, niftyListed)).toEqual({ expiry: '2026-12-29', source: 'message' });
  });
  it('month only with nothing listed that month is a mismatch that names no other contract', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: null, month: 2, year: null }, at, niftyListed);
    expect(r.mismatch).toMatch(/2027-02/);
    expect(niftyListed).not.toContain(r.expiry);
  });
  it('monthly → the nearest live month’s last expiry', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, at, niftyListed)).toEqual({ expiry: '2026-12-29', source: 'message' });
    const nov20 = new Date('2026-11-20T05:00:00Z');
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, nov20, ['2026-11-24', ...niftyListed])).toEqual({ expiry: '2026-11-24', source: 'message' });
  });
  it('weekly / this expiry → nearest; next → the one after', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'WEEKLY' }, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'CURRENT' }, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT' }, at, niftyListed)).toEqual({ expiry: '2026-12-08', source: 'message' });
  });
  it('relative without the master uses the calendar rule', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, at, null)).toEqual({ expiry: '2026-12-29', source: 'rule' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT' }, at, null)).toEqual({ expiry: '2026-12-08', source: 'rule' });
  });
  it('no hint → nearest listed (unchanged)', () => {
    expect(inferExpiry('NIFTY', 'PE', null, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'master' });
  });
});
