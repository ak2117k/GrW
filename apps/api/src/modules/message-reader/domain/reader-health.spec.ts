import type { Claim } from './reading.types';
import { deadReaderText, marketNoteClaims, marketNoteText, readerUnhealthy, withinReaderWindow } from './reader-health';

const claim = (o: Partial<Claim> = {}): Claim => ({
  text: 'stocks weak, index strong',
  subject: 'MARKET',
  bias: 'CAUTION',
  horizon: 'INTRADAY',
  claimType: 'RELATIVE_BREADTH',
  verdict: 'CONFIRMED',
  evidence: [{ fact: 'A/D', value: '0.6', source: 'breadth' }],
  ...o,
});

describe('readerUnhealthy', () => {
  it('alerts when posts arrive and nothing is read', () => {
    expect(readerUnhealthy({ posts15m: 3, read15m: 0, marketOpen: true })).toBe(true);
  });
  it('quiet when the market is closed', () => {
    expect(readerUnhealthy({ posts15m: 9, read15m: 0, marketOpen: false })).toBe(false);
  });
  it('quiet with 2 posts', () => {
    expect(readerUnhealthy({ posts15m: 2, read15m: 0, marketOpen: true })).toBe(false);
  });
  it('quiet when at least one post was read', () => {
    expect(readerUnhealthy({ posts15m: 10, read15m: 1, marketOpen: true })).toBe(false);
  });
});

describe('withinReaderWindow (09:15–15:30 IST)', () => {
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+05:30`);
  it('is inside at 09:15 and 15:30, outside at 09:14 and 15:31', () => {
    expect(withinReaderWindow(at('09:15'))).toBe(true);
    expect(withinReaderWindow(at('15:30'))).toBe(true);
    expect(withinReaderWindow(at('09:14'))).toBe(false);
    expect(withinReaderWindow(at('15:31'))).toBe(false);
  });
});

describe('deadReaderText', () => {
  it('names the counts, the last read in IST and the last error', () => {
    const now = new Date('2026-11-25T06:00:00Z'); // 11:30 IST
    const t = deadReaderText({ posts15m: 4, lastReadAt: new Date('2026-11-25T04:10:00Z'), lastError: 'message reader timed out after 25000 ms' }, now);
    expect(t).toContain('posts 4, read 0 in 15 min');
    expect(t).toContain('last read 09:40 IST');
    expect(t).toContain('last error message reader timed out after 25000 ms');
  });
  it('says never / none, and dates a last read from another day', () => {
    const now = new Date('2026-11-25T06:00:00Z');
    expect(deadReaderText({ posts15m: 3, lastReadAt: null, lastError: null }, now)).toContain('last read never; last error none');
    expect(deadReaderText({ posts15m: 3, lastReadAt: new Date('2026-11-24T09:00:00Z'), lastError: null }, now)).toContain('last read 2026-11-24 14:30 IST');
  });
});

describe('market-note alert content', () => {
  it('keeps only market-wide CONFIRMED claims with a CAUTION / BEAR / BULL bias', () => {
    const keep = [claim(), claim({ bias: 'BEAR', text: 'weak day' }), claim({ bias: 'BULL', text: 'strong day' })];
    const drop = [
      claim({ verdict: 'UNCLEAR' }),
      claim({ verdict: 'CONTRADICTED' }),
      claim({ bias: 'NEUTRAL' }),
      claim({ subject: 'RELIANCE' }),
      claim({ subject: 'BANK' }),
    ];
    expect(marketNoteClaims([...drop, ...keep])).toEqual(keep);
  });
  it('formats "<channel> HH:MM — <claim> → CONFIRMED (<evidence>)"', () => {
    const t = marketNoteText('Stock Gainers', new Date('2026-11-25T04:01:00Z'), [claim(), claim({ text: 'FIIs selling', evidence: [{ fact: 'FII cash', value: '-1200 cr', source: 'flows' }] })]);
    expect(t).toBe('Stock Gainers 09:31 — stocks weak, index strong → CONFIRMED (A/D 0.6)\nStock Gainers 09:31 — FIIs selling → CONFIRMED (FII cash -1200 cr)');
  });
});
