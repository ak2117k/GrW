import { expiryOwner } from './expiry-owner';
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
    ['NIFTY 25700 PE DEC SERIES above 330', { day: null, month: 12, year: null }],
    ['BANKNIFTY NOV SERIES 52000 CE buy 300', { day: null, month: 11, year: null }],
    ['NIFTY 25700 PE 26 MAY EXPIRY above 330', { day: 26, month: 5, year: null }],
    ['NIFTY 25700 PE (30 MAR) above 330', { day: 30, month: 3, year: null }],
    ['NIFTY 25700 PE monthly expiry above 330', { day: null, month: 0, year: null, relative: 'MONTHLY' }],
    ['NIFTY MONTHLY 25700 PE above 330', { day: null, month: 0, year: null, relative: 'MONTHLY' }],
    ['NIFTY 25700 PE weekly expiry above 330', { day: null, month: 0, year: null, relative: 'WEEKLY' }],
    ['NIFTY 25700 PE next week expiry above 330', { day: null, month: 0, year: null, relative: 'NEXT_WEEK' }],
    ['NIFTY 25700 PE next expiry above 330', { day: null, month: 0, year: null, relative: 'NEXT' }],
    ['(Next expiry) NIFTY 25700 PE above 330', { day: null, month: 0, year: null, relative: 'NEXT' }],
    ['NIFTY 25700 PE above 330, expiry: next week', { day: null, month: 0, year: null, relative: 'NEXT_WEEK' }],
    ['NIFTY 25700 PE this expiry above 330', { day: null, month: 0, year: null, relative: 'CURRENT' }],
    ['NIFTY 25700 PE current week expiry above 330', { day: null, month: 0, year: null, relative: 'CURRENT' }],
    ['Nifty 25700 PE agle hafte ki expiry 330 ke upar', { day: null, month: 0, year: null, relative: 'NEXT_WEEK' }],
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
    'BUY NIFTY 25700 PE above 330, hold till next expiry',
    'Hold for next week expiry special: NIFTY 25700 PE above 330',
    'BANKNIFTY 52000 PE buy 300-310 sl 270 target 350 400',
    'NIFTY 25700 PE you may 20 points more',
    'BUY NIFTY 25700 PE above 330, 25 may come soon',
    'NIFTY 25700 PE above 330, 20 mar ke nikal jana',
    'NIFTY will march 30 points higher today',
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

  it('a multi-underlying post: the expiry belongs to the one it sits next to', () => {
    const text = 'BUY CRUDEOIL 7500 PE 16 DEC EX above 200\nBUY NIFTY 25700 PE above 330';
    expect(expiryOwner(text, vocab)).toMatchObject({ owner: 'CRUDEOIL' });
    expect(expiryOwner('BUY NIFTY 25700 PE above 330 (29 DEC)', vocab)).toMatchObject({ owner: 'NIFTY', named: ['NIFTY'] });
    expect(expiryOwner('BUY NIFTY 25700 PE above 330', vocab).owner).toBeNull();
  });
});

describe('expiry inference from a named expiry', () => {
  // Fri 2026-11-27 09:19 IST
  const at = new Date('2026-11-27T03:49:35Z');
  // The real Angel master (2026-11-28): NIFTY weeklies to 29-Dec, then monthlies (25-Jan is the Republic Day shift).
  const niftyListed = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-25', '2027-02-23', '2027-03-30'];
  const bankniftyListed = ['2026-12-29', '2027-01-25', '2027-02-23', '2027-03-30'];
  const sensexListed = ['2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31'];
  const nifty = (text: string, list = niftyListed) => inferExpiry('NIFTY', 'CE', expiryHintOfText(text), at, list, { exchange: 'NFO' });

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

  describe('holiday shift', () => {
    it('NIFTY "26 JAN" (a Tuesday, Republic Day) → the listed Monday 25-Jan', () => {
      expect(nifty('BUY NIFTY 26000 CE 26 JAN above 100')).toEqual({ expiry: '2027-01-25', source: 'message', expiryShifted: { named: '2027-01-26', listed: '2027-01-25' } });
    });
    it('a monthly-only name (BANKNIFTY) shifts only in the last week of the month', () => {
      expect(inferExpiry('BANKNIFTY', 'CE', { day: 26, month: 1, year: null }, at, bankniftyListed)).toMatchObject({ expiry: '2027-01-25', expiryShifted: { named: '2027-01-26', listed: '2027-01-25' } });
      // A named Tuesday outside the last week (12-Jan) does not shift onto a listed Monday before it.
      const r = inferExpiry('BANKNIFTY', 'CE', { day: 12, month: 1, year: null }, at, ['2026-12-29', '2027-01-11', '2027-02-23', '2027-03-30']);
      expect(r.expiryShifted).toBeUndefined();
      expect(r.mismatch).toMatch(/2027-01-12/);
    });
    it.each([
      ['"by DEC 31" (a Thursday)', 'BUY NIFTY 26000 CE above 100 target 200 by DEC 31', '2026-12-31'],
      ['"target by 31st Dec"', 'BUY NIFTY 26000 CE above 100 target by 31st Dec', '2026-12-31'],
      ['"till 2 DEC" (a Wednesday)', 'BUY NIFTY 26000 CE above 100 hold till 2 DEC', '2026-12-02'],
      ['SENSEX\'s "(03 DEC EX)" on a NIFTY call (a Thursday)', 'NIFTY 25700 PE (03 DEC EX) above 330', '2026-12-03'],
    ])('NIFTY %s never shifts to an earlier contract', (_why, text, named) => {
      const r = nifty(text);
      expect(r.expiryShifted).toBeUndefined();
      expect(r).toMatchObject({ expiry: named, mismatch: expect.stringMatching(/not listed/) });
    });
    it('a 3-day gap is rejected', () => {
      // Tue 15-Dec with only Sat 12-Dec before it.
      const r = inferExpiry('NIFTY', 'PE', { day: 15, month: 12, year: null }, at, ['2026-12-01', '2026-12-08', '2026-12-12', '2026-12-22', '2026-12-29']);
      expect(r).toMatchObject({ expiry: '2026-12-15', mismatch: expect.stringMatching(/not listed/) });
      expect(r.expiryShifted).toBeUndefined();
    });
    it('two candidates are rejected', () => {
      const r = inferExpiry('NIFTY', 'PE', { day: 15, month: 12, year: null }, at, ['2026-12-01', '2026-12-08', '2026-12-13', '2026-12-14', '2026-12-22', '2026-12-29']);
      expect(r).toMatchObject({ expiry: '2026-12-15', mismatch: expect.stringMatching(/not listed/) });
      expect(r.expiryShifted).toBeUndefined();
    });
    it('never across a month', () => {
      // Tue 02-Mar-2027 with Mon/Sun 01-Mar… none; Tue 01-Jun-2027 with 31-May listed is another month.
      const r = inferExpiry('NIFTY', 'PE', { day: 1, month: 6, year: 2027 }, at, [...niftyListed, '2027-05-31', '2027-06-29']);
      expect(r.mismatch).toMatch(/2027-06-01/);
    });
    it('never on MCX', () => {
      const r = inferExpiry('CRUDEOIL', 'PE', { day: 17, month: 12, year: null }, at, ['2026-12-16', '2027-01-15'], { exchange: 'MCX' });
      expect(r.expiryShifted).toBeUndefined();
      expect(r.mismatch).toMatch(/2026-12-17/);
    });
    it('SENSEX "26 DEC" (a Saturday) stays unresolved although 24-Dec is listed (real master 2026-11-28)', () => {
      const nov26 = new Date('2026-11-26T03:58:32Z');
      const r = inferExpiry('SENSEX', 'PE', { day: 26, month: 12, year: null }, nov26, sensexListed, { exchange: 'BFO' });
      expect(r).toMatchObject({ expiry: '2026-12-26', mismatch: expect.stringMatching(/not listed/) });
      expect(r.expiryShifted).toBeUndefined();
    });
  });

  it('a named day already expired (gone from the master) is a mismatch', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: 23, month: 11, year: null }, at, niftyListed);
    expect(r.mismatch).toMatch(/2026-11-23 has already expired/);
  });
  it('a listed day named after the 15:15 cutoff on that day stays that contract', () => {
    const late = new Date('2026-11-26T09:56:02Z'); // 15:26 IST on the SENSEX 26-Nov expiry
    expect(inferExpiry('SENSEX', 'CE', { day: 26, month: 11, year: 2026 }, late, sensexListed)).toEqual({ expiry: '2026-11-26', source: 'message' });
  });
  it('MCX: a month-only post on expiry evening is that day\'s contract (MCX trades it until its close)', () => {
    // COPPER "EXPIRY - NOVEMBER", 2026-11-23 19:37 IST, the copper Nov expiry day.
    const eve = new Date('2026-11-23T14:07:00Z');
    expect(inferExpiry('COPPER', 'CE', { day: null, month: 11, year: null }, eve, ['2026-11-23', '2026-12-23'], { exchange: 'MCX' })).toEqual({ expiry: '2026-11-23', source: 'message' });
    // NSE at the same minute has already rolled past its 15:15 cutoff.
    expect(inferExpiry('NIFTY', 'CE', null, eve, ['2026-11-23', '2026-12-01'], { exchange: 'NFO' })).toEqual({ expiry: '2026-12-01', source: 'master' });
  });
  it('month only → that month’s last listed expiry (the monthly)', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 12, year: null }, at, niftyListed)).toEqual({ expiry: '2026-12-29', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 1, year: null }, at, niftyListed)).toEqual({ expiry: '2027-01-25', source: 'message' });
  });
  it('month only with nothing listed that month is a mismatch that names no other contract', () => {
    const r = inferExpiry('NIFTY', 'PE', { day: null, month: 4, year: null }, at, niftyListed);
    expect(r.mismatch).toMatch(/2027-04/);
    expect(niftyListed).not.toContain(r.expiry);
  });
  it('monthly → the nearest live month’s last expiry', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, at, niftyListed)).toEqual({ expiry: '2026-12-29', source: 'message' });
    const nov20 = new Date('2026-11-20T05:00:00Z');
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, nov20, ['2026-11-23', ...niftyListed])).toEqual({ expiry: '2026-11-23', source: 'message' });
  });
  it('weekly / this expiry → nearest; next / next week → the one after', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'WEEKLY' }, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'CURRENT' }, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT' }, at, niftyListed)).toEqual({ expiry: '2026-12-08', source: 'message' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT_WEEK' }, at, niftyListed)).toEqual({ expiry: '2026-12-08', source: 'message' });
  });
  it('"next week expiry" on a monthly-only name (BANKNIFTY "agle hafte ki expiry") is a mismatch, never next month', () => {
    const r = inferExpiry('BANKNIFTY', 'PE', expiryHintOfText('Banknifty 60900 PE agle hafte ki expiry 427 ke upar'), at, bankniftyListed);
    expect(r.mismatch).toMatch(/no weekly expiries/);
    expect(bankniftyListed).not.toContain(r.expiry);
    // "next expiry" (not "week") on BANKNIFTY is the next monthly.
    expect(inferExpiry('BANKNIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT' }, at, bankniftyListed)).toEqual({ expiry: '2027-01-25', source: 'message' });
  });
  it('relative without the master uses the calendar rule', () => {
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'MONTHLY' }, at, null)).toEqual({ expiry: '2026-12-29', source: 'rule' });
    expect(inferExpiry('NIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT' }, at, null)).toEqual({ expiry: '2026-12-08', source: 'rule' });
    expect(inferExpiry('BANKNIFTY', 'PE', { day: null, month: 0, year: null, relative: 'NEXT_WEEK' }, at, null).mismatch).toMatch(/no weekly/);
  });
  it('no hint → nearest listed (unchanged)', () => {
    expect(inferExpiry('NIFTY', 'PE', null, at, niftyListed)).toEqual({ expiry: '2026-12-01', source: 'master' });
  });
});
